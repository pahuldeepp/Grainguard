package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	common "greenguard.local/go-common"
)

const (
	contentTypeJSON    = "application/json"
	contentTypeProblem = "application/problem+json"
	headerContentType  = "Content-Type"
	headerRetryAfter   = "Retry-After"
	readinessTimeout   = time.Second
	authRetryAfter     = "5"
	problemBlank       = "about:blank"
	codeInternal       = "internal_error"
	codeNotFound       = "not_found"
	serviceName        = "telemetry-ingest"
)

// App holds the service's collaborators. Ping is always required. When Verifier is set the
// ingest endpoint is mounted and Ingestor, Limiter, Recorder and Metrics must be set too;
// without it the service exposes only its health probes.
type App struct {
	DBPool   *pgxpool.Pool
	Consumer *BindingConsumer
	Feed     *BindingFeed
	Ping     func(context.Context) error
	Verifier *Verifier
	APIKeys  *APIKeyVerifier
	Ingestor *Ingestor
	Limiter  Limiter
	Recorder *RejectionRecorder
	Metrics  *Metrics
	Tracing  *Tracing
	PreAuth  *PreAuthGuard
}

func newHandler(app App) http.Handler {
	if app.PreAuth == nil {
		app.PreAuth = NewPreAuthGuard()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeStatus(w, http.StatusOK, "ok") })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), readinessTimeout)
		defer cancel()
		if err := app.Ping(ctx); err != nil || (app.Consumer != nil && !app.Consumer.Ready.Load()) {
			writeStatus(w, http.StatusServiceUnavailable, "not_ready")
			return
		}
		writeStatus(w, http.StatusOK, "ready")
	})
	mux.Handle("GET /metrics", app.metricsHandler())
	if app.Verifier != nil {
		mux.Handle("POST /v1/devices/{deviceId}/readings", app.PreAuth.middleware(http.HandlerFunc(app.ingest)))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeProblem(w, r, http.StatusNotFound, codeNotFound, "")
	})
	handler := common.REDMetrics(CorrelationMiddleware(mux))
	if app.Tracing != nil {
		handler = app.Tracing.Middleware(handler)
	}
	return handler
}

func writeStatus(w http.ResponseWriter, code int, status string) {
	w.Header().Set(headerContentType, contentTypeJSON)
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"service": serviceName, "status": status})
}

type problemBody struct {
	Type          string `json:"type"`
	Title         string `json:"title"`
	Status        int    `json:"status"`
	Code          string `json:"code"`
	Detail        string `json:"detail,omitempty"`
	CorrelationID string `json:"correlation_id"`
}

func writeProblem(w http.ResponseWriter, r *http.Request, status int, code, detail string, headers ...string) {
	w.Header().Set(headerContentType, contentTypeProblem)
	for i := 0; i+1 < len(headers); i += 2 {
		w.Header().Set(headers[i], headers[i+1])
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(problemBody{
		Type: problemBlank, Title: http.StatusText(status), Status: status, Code: code, Detail: detail,
		CorrelationID: RequestMetaFrom(r.Context()).CorrelationID,
	})
}

func writeAuthError(w http.ResponseWriter, r *http.Request, err error) {
	var authErr *AuthError
	if !errors.As(err, &authErr) {
		writeProblem(w, r, http.StatusInternalServerError, codeInternal, "")
		return
	}
	switch authErr.Status {
	case http.StatusUnauthorized:
		writeProblem(w, r, authErr.Status, authErr.Code, "", "WWW-Authenticate", "Bearer")
	case http.StatusServiceUnavailable:
		writeProblem(w, r, authErr.Status, authErr.Code, "", headerRetryAfter, authRetryAfter)
	default:
		writeProblem(w, r, authErr.Status, authErr.Code, "")
	}
}

// limitDevice picks the device bucket from the verified identity: a device token can only
// spend its own bucket, so a forged path cannot exhaust another device's allowance.
func limitDevice(p Principal, pathDevice string) string {
	if p.HasRole(RoleDevice) && !p.HasRole(RoleOperator) && !p.HasRole(RoleAdmin) {
		return p.Subject
	}
	return pathDevice
}

// admit authenticates and rate limits; it writes the response itself when it refuses.
func (a App) admit(w http.ResponseWriter, r *http.Request) (Principal, string, bool) {
	deviceID := r.PathValue("deviceId")
	var principal Principal
	var err error
	if a.PreAuth != nil {
		if !a.PreAuth.AcquireVerification() {
			writeProblem(w, r, http.StatusTooManyRequests, "rate_limited", "Credential verification is busy; retry later.", headerRetryAfter, "1")
			return Principal{}, "", false
		}
		defer a.PreAuth.ReleaseVerification()
	}
	if a.APIKeys != nil && len(r.Header.Get("Authorization")) >= 10 &&
		strings.HasPrefix(strings.ToLower(r.Header.Get("Authorization")), "bearer gg_") {
		principal, err = a.APIKeys.Verify(r.Context(), r.Header.Get("Authorization"), deviceID)
	} else if a.APIKeys != nil && looksLikeM2M(r.Header.Get("Authorization")) {
		principal, err = a.APIKeys.VerifyOAuth(r.Context(), r.Header.Get("Authorization")[7:])
	} else {
		principal, err = a.Verifier.Verify(r.Header.Get("Authorization"))
	}
	if err != nil {
		writeAuthError(w, r, err)
		return Principal{}, "", false
	}
	if !isUUID(deviceID) {
		a.refuse(w, r, principal, deviceID, newRejection(ReasonInvalidField, http.StatusBadRequest, "device id must be a lowercase UUID"), nil)
		return Principal{}, "", false
	}
	var allowed bool
	var wait time.Duration
	if principal.KeyID != "" {
		if keyed, ok := a.Limiter.(interface {
			AllowKey(string, string, string) (bool, time.Duration)
		}); ok {
			allowed, wait = keyed.AllowKey(principal.TenantID, limitDevice(principal, deviceID), principal.KeyID)
		} else {
			allowed, wait = a.Limiter.Allow(principal.TenantID, limitDevice(principal, deviceID))
		}
	} else {
		allowed, wait = a.Limiter.Allow(principal.TenantID, limitDevice(principal, deviceID))
	}
	if !allowed {
		a.Metrics.IncRejection(ReasonRateLimited)
		seconds := max(1, int(math.Ceil(wait.Seconds())))
		writeProblem(w, r, http.StatusTooManyRequests, ReasonRateLimited, "Too many readings; retry later.",
			headerRetryAfter, strconv.Itoa(seconds))
		return Principal{}, "", false
	}
	return principal, deviceID, true
}

func (a App) ingest(w http.ResponseWriter, r *http.Request) {
	principal, deviceID, ok := a.admit(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		a.refuse(w, r, principal, deviceID, newRejection(ReasonInvalidBody, http.StatusBadRequest, "The request body could not be read."), nil)
		return
	}
	result, err := a.Ingestor.Ingest(r.Context(), principal, deviceID, body, RequestMetaFrom(r.Context()))
	if err != nil {
		var rejection *Rejection
		if errors.As(err, &rejection) {
			a.refuse(w, r, principal, deviceID, rejection, body)
			return
		}
		slog.Error("ingest failed", "error", err)
		writeProblem(w, r, http.StatusInternalServerError, codeInternal, "")
		return
	}
	a.Metrics.IncAccepted()
	w.Header().Set(headerContentType, contentTypeJSON)
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(result)
}

func (a App) refuse(w http.ResponseWriter, r *http.Request, p Principal, deviceID string, rejection *Rejection, body []byte) {
	a.Recorder.Record(r.Context(), p.TenantID, deviceID, rejection, body)
	if rejection.Reason == bindingFeedStale || rejection.Reason == ReasonTelemetryV2Disabled {
		writeProblem(w, r, rejection.Status, rejection.Reason, rejection.Detail, headerRetryAfter, authRetryAfter)
		return
	}
	if rejection.Reason == ReasonEntitlementVolume {
		// A monthly quota does not reset after the fixed five-second retry used
		// for transient service unavailability. Do not advertise a false delay.
		writeProblem(w, r, rejection.Status, rejection.Reason, rejection.Detail)
		return
	}
	writeProblem(w, r, rejection.Status, rejection.Reason, rejection.Detail)
}

func (a App) metricsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(headerContentType, "text/plain; version=0.0.4; charset=utf-8")
		if a.Metrics != nil {
			_, _ = io.WriteString(w, a.Metrics.render())
		}
		if a.Consumer != nil {
			_, _ = io.WriteString(w, a.Consumer.metrics())
		}
		if a.Feed != nil {
			ctx, cancel := context.WithTimeout(r.Context(), readinessTimeout)
			defer cancel()
			_, _ = io.WriteString(w, a.Feed.metrics(ctx))
		}
		_, _ = io.WriteString(w, common.RenderREDMetrics())
		if a.DBPool != nil {
			_, _ = io.WriteString(w, common.RenderPGXPoolMetrics("telemetry_ingest", a.DBPool.Stat()))
		}
	})
}
