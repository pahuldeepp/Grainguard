package hardware

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	common "greenguard.local/go-common"
	"log"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/jackc/pgx/v5"
)

var ErrPermanentMQTTAck = errors.New("permanent invalid device acknowledgement")

func permanentMQTTAck(err error) error {
	return fmt.Errorf("%w: %v", ErrPermanentMQTTAck, err)
}

const mqttTopicPrefix = "greenguard/"

// Configuration messages are tenant- and asset-scoped. Device firmware must
// persist command_id and return the same identity in an authenticated ack.
type ConfigureMessage struct {
	TenantID     string `json:"tenant_id"`
	AssetID      string `json:"asset_id"`
	DeviceID     string `json:"device_id"`
	SagaID       string `json:"saga_id"`
	CommandID    string `json:"command_id"`
	SagaVersion  int64  `json:"saga_version"`
	FencingToken int64  `json:"fencing_token"`
	Status       string `json:"status"`
	MAC          string `json:"mac"`
}

func messageFor(c Command, status string) ConfigureMessage {
	return ConfigureMessage{TenantID: c.TenantID, AssetID: c.Payload.AssetID, DeviceID: c.Payload.DeviceID, SagaID: c.SagaID, CommandID: c.CommandID, SagaVersion: c.SagaVersion, FencingToken: c.FencingToken, Status: status}
}
func (m ConfigureMessage) body() string {
	return fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%d\n%d\n%s", m.TenantID, m.AssetID, m.DeviceID, m.SagaID, m.CommandID, m.SagaVersion, m.FencingToken, m.Status)
}
func (m *ConfigureMessage) Sign(secret []byte) {
	h := hmac.New(sha256.New, secret)
	_, _ = h.Write([]byte(m.body()))
	m.MAC = hex.EncodeToString(h.Sum(nil))
}
func (m ConfigureMessage) Verify(secret []byte) bool {
	expected := m
	expected.Sign(secret)
	a, e := hex.DecodeString(m.MAC)
	if e != nil {
		return false
	}
	b, _ := hex.DecodeString(expected.MAC)
	return EqualMAC(a, b)
}
func commandTopic(c Command) string {
	return mqttTopicPrefix + c.TenantID + "/" + c.Payload.AssetID + "/command"
}
func ackTopic(c Command) string {
	return mqttTopicPrefix + c.TenantID + "/" + c.Payload.AssetID + "/ack"
}

// MQTTDispatcher republishes durable pending intents with their stable command
// identity. A missing ack leaves the receipt pending, never rejected.
type MQTTDispatcher struct {
	Store        Store
	Client       Publisher
	PollInterval time.Duration
	BatchSize    int
}

// Publisher is the MQTT capability the dispatcher needs; mqtt.Client satisfies it.
type Publisher interface {
	Publish(topic string, qos byte, retained bool, payload interface{}) mqtt.Token
}

func (d MQTTDispatcher) Run(ctx context.Context) error {
	if d.Client == nil {
		return errors.New("MQTT client required")
	}
	interval := d.PollInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := d.PublishPending(ctx); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func (d MQTTDispatcher) PublishPending(ctx context.Context) error {
	claimed, err := d.Store.ClaimPendingConfigurations(ctx, d.BatchSize)
	if err != nil {
		return err
	}
	for _, item := range claimed {
		if len(item.Secret) < 32 {
			log.Printf("pending hardware configuration blocked command=%s: device acknowledgement key is missing or too short", item.Command.CommandID)
			continue
		}
		m := messageFor(item.Command, "configure")
		m.Sign(item.Secret)
		data, err := json.Marshal(m)
		if err != nil {
			return err
		}
		err = d.Store.WithExternalAdmission(ctx, item.Command.TenantID, func() error {
			token := d.Client.Publish(commandTopic(item.Command), 1, false, data)
			if !token.WaitTimeout(5 * time.Second) {
				log.Printf("MQTT publish timed out for pending hardware command=%s; it remains pending", item.Command.CommandID)
				return nil
			}
			if err = token.Error(); err != nil {
				log.Printf("MQTT publish failed for pending hardware command=%s: %v", item.Command.CommandID, err)
				return nil
			}
			return nil
		})
		if errors.Is(err, common.ErrTenantQuiescing) {
			continue
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// HandleAck performs exact correlation and device-key attestation before any
// state transition. A broker acknowledgement or MQTT delivery alone is not proof.
func (d MQTTDispatcher) HandleAck(ctx context.Context, topic string, data []byte) (Result, error) {
	var m ConfigureMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return Result{}, permanentMQTTAck(err)
	}
	if m.Status != "configured" || !strings.HasPrefix(topic, mqttTopicPrefix) {
		return Result{}, permanentMQTTAck(errors.New("unsupported device acknowledgement"))
	}
	if !strings.EqualFold(topic, mqttTopicPrefix+m.TenantID+"/"+m.AssetID+"/ack") {
		return Result{}, permanentMQTTAck(errors.New("ack topic identity mismatch"))
	}
	if !validIdentity(m) {
		return Result{}, permanentMQTTAck(ErrInvalidCommand)
	}
	c, err := d.Store.PendingCommand(ctx, m.TenantID, m.CommandID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Result{}, permanentMQTTAck(errors.New("no pending command matches acknowledgement"))
		}
		return Result{}, err
	}
	expected := messageFor(c, "configured")
	if m.TenantID != expected.TenantID || m.AssetID != expected.AssetID || m.DeviceID != expected.DeviceID || m.SagaID != expected.SagaID || m.SagaVersion != expected.SagaVersion || m.FencingToken != expected.FencingToken {
		return Result{}, permanentMQTTAck(errors.New("ack command identity mismatch"))
	}
	secret, err := d.Store.ConfigureSecret(ctx, c)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, ErrMissingAckSecret) {
			return Result{}, permanentMQTTAck(errors.New("device acknowledgement key is unavailable"))
		}
		return Result{}, err
	}
	if !m.Verify(secret) {
		return Result{}, permanentMQTTAck(errors.New("invalid device attestation"))
	}
	result, err := d.Store.ConfirmConfiguration(ctx, c, secret)
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, ErrInvalidCommand) || errors.Is(err, ErrStaleCommand) {
		return Result{}, permanentMQTTAck(err)
	}
	return result, err
}
func validIdentity(m ConfigureMessage) bool {
	return valid(Command{TenantID: m.TenantID, SagaID: m.SagaID, CommandID: m.CommandID, Step: hardwareStepConfigure, SagaVersion: m.SagaVersion, FencingToken: m.FencingToken, Payload: struct {
		TenantID string `json:"tenant_id"`
		SagaID   string `json:"saga_id"`
		DeviceID string `json:"device_id"`
		AssetID  string `json:"asset_id"`
	}{m.TenantID, m.SagaID, m.DeviceID, m.AssetID}})
}

// NewConfigureAck is the device-side test contract for a successful
// configuration. Firmware must implement the same canonical signed fields.
func NewConfigureAck(c Command, secret []byte) ConfigureMessage {
	m := messageFor(c, "configured")
	m.Sign(secret)
	return m
}
