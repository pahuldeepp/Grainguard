package common

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
)

// Decode preserves JSON integer precision and rejects a second JSON value.
func Decode(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("trailing JSON data")
	}
	return value, nil
}

// Bigint accepts only canonical positive signed-int64 decimal representation.
func Bigint(value any) (string, error) {
	var text string
	switch v := value.(type) {
	case string:
		text = v
	case json.Number:
		text = string(v)
	default:
		return "", errors.New("version must be an integer or decimal string")
	}
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != text {
		return "", errors.New("version must be a positive signed bigint without leading zeros")
	}
	return text, nil
}
