package main

import (
	"context"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

func maintainMQTTConnection(
	ctx context.Context,
	client mqtt.Client,
	reconnect <-chan struct{},
	onError func(error),
) {
	backoff := 250 * time.Millisecond
	const maxBackoff = 10 * time.Second
	var connectedAt time.Time
	for ctx.Err() == nil {
		if client.IsConnected() {
			select {
			case <-ctx.Done():
				return
			case <-reconnect:
				client.Disconnect(250)
				if time.Since(connectedAt) >= maxBackoff {
					backoff = 250 * time.Millisecond
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

		token := client.Connect()
		select {
		case <-ctx.Done():
			token.WaitTimeout(time.Second)
			return
		case <-token.Done():
			if err := token.Error(); err != nil {
				if onError != nil {
					onError(err)
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
				continue
			}
			connectedAt = time.Now()
			if client.IsConnected() {
				select {
				case <-reconnect:
				default:
				}
			}
		}
	}
}
