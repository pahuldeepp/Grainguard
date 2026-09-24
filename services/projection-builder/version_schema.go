package main

import (
	"errors"
	"regexp"
)

var ErrInvalidProjectionSchema = errors.New("projection schema must be public or read_v<N>")
var versionSchemaPattern = regexp.MustCompile(`^read_v[1-9][0-9]{0,8}$`)
