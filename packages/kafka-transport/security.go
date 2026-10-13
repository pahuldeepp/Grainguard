package transport

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/plain"
)

// SecurityOptions reads the common Kafka security contract. A requested secure
// connection is never silently downgraded if any credential or CA is missing.
func SecurityOptions(getenv func(string) string) ([]kgo.Opt, error) {
	protocol := strings.ToUpper(strings.TrimSpace(getenv("KAFKA_SECURITY_PROTOCOL")))
	required := strings.EqualFold(getenv("KAFKA_REQUIRE_TLS"), "true")
	mechanism := strings.ToUpper(strings.TrimSpace(getenv("KAFKA_SASL_MECHANISM")))
	user, password, caFile := getenv("KAFKA_SASL_USERNAME"), getenv("KAFKA_SASL_PASSWORD"), getenv("KAFKA_TLS_CA_FILE")
	if protocol == "" && !required && mechanism == "" && user == "" && password == "" && caFile == "" {
		return nil, nil // local plaintext broker
	}
	if protocol != "SASL_SSL" || mechanism != "PLAIN" || user == "" || password == "" || caFile == "" {
		return nil, errors.New("Kafka requires SASL_SSL, PLAIN credentials, and a TLS CA file")
	}
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read Kafka TLS CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		return nil, errors.New("Kafka TLS CA file contains no certificates")
	}
	return []kgo.Opt{kgo.DialTLSConfig(&tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}),
		kgo.SASL(plain.Auth{User: user, Pass: password}.AsMechanism())}, nil
}

func SecureOptions(brokers []string, group string, topics []string, extra ...kgo.Opt) ([]kgo.Opt, error) {
	security, err := SecurityOptions(os.Getenv)
	if err != nil {
		return nil, err
	}
	return append(Options(brokers, group, topics, extra...), security...), nil
}
