// Package history shares the hot/cold query boundary with projection maintenance.
package history

import (
	"fmt"
	"strconv"
	"time"
)

const DefaultWindow = 24 * time.Hour
const LockID = 7240511
const WindowEnv = "PROJECTION_HISTORY_HOT_WINDOW"
const AheadEnv = "PROJECTION_HISTORY_AHEAD_DAYS"

func Window(getenv func(string) string) (time.Duration, error) {
	value := getenv(WindowEnv)
	if value == "" {
		return DefaultWindow, nil
	}
	window, err := time.ParseDuration(value)
	if err != nil || window < time.Hour || window > 90*24*time.Hour {
		return 0, fmt.Errorf("%s must be between 1h and 2160h", WindowEnv)
	}
	return window, nil
}
func Ahead(getenv func(string) string) (int, error) {
	value := getenv(AheadEnv)
	if value == "" {
		return 3, nil
	}
	days, err := strconv.Atoi(value)
	if err != nil || days < 1 || days > 30 {
		return 0, fmt.Errorf("%s must be between 1 and 30", AheadEnv)
	}
	return days, nil
}
