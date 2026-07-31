package store

import (
	"bufio"
	"errors"
	"io"
	"os"
)

// newReader avvolge il file in un bufio.Reader (io.ByteReader) per protodelim.
func newReader(f *os.File) *bufio.Reader {
	return bufio.NewReader(f)
}

func isEOF(err error) bool { return errors.Is(err, io.EOF) }
