package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"os"
)

// mqttTLSConfig uses the broker hostname for normal TLS certificate validation.
// A private CA file is required by the disposable broker; the local TCP broker
// remains available without a CA file.
func mqttTLSConfig(brokerURL, caFile string) (*tls.Config, error) {
	u, err := url.Parse(brokerURL)
	if err != nil || u.Hostname() == "" {
		return nil, errors.New("MQTT_BROKER_URL must contain a broker hostname")
	}
	if u.Scheme != "tls" && u.Scheme != "ssl" {
		if caFile != "" {
			return nil, errors.New("MQTT_CA_FILE requires a tls:// broker URL")
		}
		return nil, nil
	}
	if caFile == "" {
		return nil, nil // TLS uses the OS trust store and ordinary hostname verification.
	}
	data, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read MQTT_CA_FILE: %w", err)
	}
	pool := x509.NewCertPool()
	count := 0
	for len(data) > 0 {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 {
			return nil, errors.New("MQTT_CA_FILE contains malformed PEM")
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil || !cert.IsCA {
			return nil, errors.New("MQTT_CA_FILE must contain CA certificates")
		}
		pool.AddCert(cert)
		count++
	}
	if count == 0 {
		return nil, errors.New("MQTT_CA_FILE is empty")
	}
	return &tls.Config{RootCAs: pool, ServerName: u.Hostname(), MinVersion: tls.VersionTLS12}, nil
}
