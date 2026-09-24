package main

import amqp "github.com/rabbitmq/amqp091-go"

func deliveryOf(body []byte) amqp.Delivery { return amqp.Delivery{Body: body} }
