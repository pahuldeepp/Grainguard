package main

import (
	"context"
	"errors"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

func subscribeAckUntilReady(
	ctx context.Context,
	connected func() bool,
	subscribe func() mqtt.Token,
	ackTimeout time.Duration,
	retryDelay time.Duration,
	granted func(mqtt.Token) bool,
	onReady func(),
	onError func(error),
) {
	if ackTimeout <= 0 {
		ackTimeout = 5 * time.Second
	}
	if retryDelay <= 0 {
		retryDelay = 250 * time.Millisecond
	}
	backoff := retryDelay
	const maxBackoff = 10 * time.Second

	for ctx.Err() == nil {
		if connected() {
			token := subscribe()
			timer := time.NewTimer(ackTimeout)
			select {
			case <-token.Done():
				timer.Stop()
				if err := token.Error(); err != nil {
					if onError != nil {
						onError(err)
					}
				} else if granted != nil && granted(token) {
					if onReady != nil {
						onReady()
					}
					return
				} else if onError != nil {
					onError(errors.New("MQTT broker rejected acknowledgement subscription"))
				}
			case <-timer.C:
				if onError != nil {
					onError(errors.New("MQTT acknowledgement subscription timed out"))
				}
				// Do not build an unbounded queue of outstanding SUBSCRIBE requests.
				select {
				case <-token.Done():
				case <-ctx.Done():
					return
				}
			case <-ctx.Done():
				timer.Stop()
				return
			}
		}

		timer := time.NewTimer(backoff)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func mqttSubscriptionTokenGranted(token mqtt.Token) bool {
	result, ok := token.(*mqtt.SubscribeToken)
	return ok && mqttSubscriptionGranted(result.Result())
}

func mqttSubscriptionGranted(results map[string]byte) bool {
	if len(results) == 0 {
		return false
	}
	for _, qos := range results {
		if qos == 0x80 {
			return false
		}
	}
	return true
}
