package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeTestCA(t *testing.T) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now()
	model := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "MQTT test root"}, NotBefore: base.Add(-time.Hour), NotAfter: base.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, model, model, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestMQTTTLSConfigUsesPrivateCAAndBrokerHostname(t *testing.T) {
	ca := writeTestCA(t)
	config, err := mqttTLSConfig("tls://mqtt.greenguard-data.svc.cluster.local:8883", ca)
	if err != nil {
		t.Fatal(err)
	}
	if config.RootCAs == nil || len(config.RootCAs.Subjects()) != 1 {
		t.Fatal("private CA was not loaded")
	}
	if config.ServerName != "mqtt.greenguard-data.svc.cluster.local" || config.InsecureSkipVerify || config.MinVersion < 0x0303 {
		t.Fatalf("unsafe broker TLS configuration: server=%q skip=%v min=%d", config.ServerName, config.InsecureSkipVerify, config.MinVersion)
	}
}

func TestMQTTTLSConfigRejectsMalformedCA(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.pem")
	for _, payload := range []string{"", "not a certificate", string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("secret")}))} {
		if err := os.WriteFile(path, []byte(payload), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := mqttTLSConfig("tls://mqtt.example:8883", path); err == nil {
			t.Fatalf("accepted invalid CA payload %q", payload)
		}
	}
	if _, err := mqttTLSConfig("tls://mqtt.example:8883", filepath.Join(t.TempDir(), "missing.pem")); err == nil {
		t.Fatal("accepted missing CA file")
	}
}

func TestMQTTTLSConfigPreservesLocalTCPWithoutCA(t *testing.T) {
	config, err := mqttTLSConfig("tcp://localhost:1883", "")
	if err != nil || config != nil {
		t.Fatalf("local TCP broker changed: config=%v err=%v", config, err)
	}
	if _, err := mqttTLSConfig("tcp://localhost:1883", "ca.pem"); err == nil || !strings.Contains(err.Error(), "requires a tls://") {
		t.Fatalf("CA over cleartext accepted: %v", err)
	}
}
