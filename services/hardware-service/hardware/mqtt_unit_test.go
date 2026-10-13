package hardware

import (
	"context"
	"errors"
	"testing"
)

func TestMalformedDeviceAcknowledgementIsPermanent(t *testing.T) {
	_, err := (MQTTDispatcher{}).HandleAck(context.Background(), "greenguard/tenant/asset/ack", []byte("{"))
	if !errors.Is(err, ErrPermanentMQTTAck) {
		t.Fatalf("HandleAck error = %v; want permanent invalid acknowledgement", err)
	}
}

func TestUnsupportedDeviceAcknowledgementIsPermanent(t *testing.T) {
	payload := []byte(`{"status":"failed"}`)
	_, err := (MQTTDispatcher{}).HandleAck(context.Background(), "greenguard/tenant/asset/ack", payload)
	if !errors.Is(err, ErrPermanentMQTTAck) {
		t.Fatalf("HandleAck error = %v; want permanent invalid acknowledgement", err)
	}
}
