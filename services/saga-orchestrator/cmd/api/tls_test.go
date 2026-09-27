package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testCertificate(t *testing.T, parent *x509.Certificate, signer *ecdsa.PrivateKey, commonName string, isCA bool, usage x509.ExtKeyUsage) ([]byte, []byte, *x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: commonName},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  isCA,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{usage},
	}
	if isCA {
		cert.KeyUsage |= x509.KeyUsageCertSign
	} else if usage == x509.ExtKeyUsageServerAuth {
		cert.DNSNames = []string{"localhost"}
	}
	if parent == nil {
		parent, signer = cert, key
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, parent, &key.PublicKey, signer)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}), parsed, key
}

func writeTestPEM(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAPITLSConfigRequiresCompleteConfiguration(t *testing.T) {
	if config, err := apiTLSConfig("", "", ""); err != nil || config != nil {
		t.Fatalf("plain loopback default: config=%v err=%v", config, err)
	}
	for _, paths := range [][3]string{{"server.pem", "", ""}, {"", "key.pem", ""}, {"", "", "ca.pem"}, {"server.pem", "key.pem", ""}} {
		if _, err := apiTLSConfig(paths[0], paths[1], paths[2]); err == nil {
			t.Fatalf("partial configuration was accepted: %v", paths)
		}
	}
	if _, err := apiTLSConfig("missing.pem", "missing-key.pem", "missing-ca.pem"); err == nil {
		t.Fatal("missing certificate was accepted")
	}
}

func TestAPIMTLSRequiresTrustedClientCertificate(t *testing.T) {
	caPEM, _, ca, caKey := testCertificate(t, nil, nil, "test CA", true, x509.ExtKeyUsageAny)
	serverPEM, serverKeyPEM, _, _ := testCertificate(t, ca, caKey, "localhost", false, x509.ExtKeyUsageServerAuth)
	clientPEM, clientKeyPEM, _, _ := testCertificate(t, ca, caKey, "trusted client", false, x509.ExtKeyUsageClientAuth)
	_, _, otherCA, otherCAKey := testCertificate(t, nil, nil, "other CA", true, x509.ExtKeyUsageAny)
	untrustedPEM, untrustedKeyPEM, _, _ := testCertificate(t, otherCA, otherCAKey, "untrusted client", false, x509.ExtKeyUsageClientAuth)
	config, err := apiTLSConfig(writeTestPEM(t, "server.pem", serverPEM), writeTestPEM(t, "server-key.pem", serverKeyPEM), writeTestPEM(t, "ca.pem", caPEM))
	if err != nil {
		t.Fatal(err)
	}
	if config.MinVersion != tls.VersionTLS13 || config.ClientAuth != tls.RequireAndVerifyClientCert {
		t.Fatalf("weak mutual TLS configuration: %+v", config)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 {
			t.Error("request reached handler without a verified client certificate")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	server.TLS = config
	server.StartTLS()
	defer server.Close()
	serverRoots := x509.NewCertPool()
	serverRoots.AppendCertsFromPEM(caPEM)
	request := func(cert *tls.Certificate) error {
		clientTLS := &tls.Config{RootCAs: serverRoots, ServerName: "localhost", MinVersion: tls.VersionTLS13}
		if cert != nil {
			clientTLS.Certificates = []tls.Certificate{*cert}
		}
		client := &http.Client{Transport: &http.Transport{TLSClientConfig: clientTLS}, Timeout: 2 * time.Second}
		response, err := client.Get(server.URL)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			t.Errorf("trusted client status = %d", response.StatusCode)
		}
		return nil
	}
	trusted, err := tls.X509KeyPair(clientPEM, clientKeyPEM)
	if err != nil {
		t.Fatal(err)
	}
	if err := request(&trusted); err != nil {
		t.Fatalf("trusted client rejected: %v", err)
	}
	if err := request(nil); err == nil {
		t.Fatal("client without certificate was accepted")
	}
	untrusted, err := tls.X509KeyPair(untrustedPEM, untrustedKeyPEM)
	if err != nil {
		t.Fatal(err)
	}
	if err := request(&untrusted); err == nil {
		t.Fatal("untrusted client was accepted")
	}
}
