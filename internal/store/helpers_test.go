package store

import "time"

func timeZero() time.Time { return time.Unix(0, 0).UTC() }
