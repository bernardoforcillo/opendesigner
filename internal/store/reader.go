package store

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
)

// Oplog framing.
//
// Every record is stored as one self-describing frame:
//
//	magic  uint32  big endian, frameMagic -- lets a reader tell a real
//	               record boundary from arbitrary bytes left behind by a
//	               torn write, and lets it resynchronise after damage.
//	length uint32  big endian, payload byte count.
//	crc    uint32  big endian, CRC-32C (Castagnoli) of the payload -- a
//	               record whose bytes were only partly flushed, or were
//	               corrupted in place, fails this check instead of being
//	               decoded as if it were intact.
//	payload        the marshalled brawtv1.OpRecord.
//
// The previous format was protodelim's varint length prefix, which
// protodelim.MarshalTo writes with two separate Write calls (a varint, then
// the payload) to an unbuffered file. A crash between them leaves a
// dangling length prefix that no reader can resynchronise on, and a later
// append lands right after it and mis-frames the rest of the file. Append
// now builds the whole frame in memory and issues a single Write, so a torn
// record is a short/failed-checksum frame rather than an undetectable one.
// The file opens with a fixed header identifying the format, so a file
// that is not a current-format oplog (notably one written by M0's previous
// protodelim framing) is reported as such instead of being mistaken for a
// single enormous torn record and truncated away.
const (
	oplogFileMagic     = "BRAWTLOG"
	oplogFormatVersion = uint32(1)
	oplogHeaderSize    = int64(len(oplogFileMagic) + 4)
)

const (
	frameMagic      uint32 = 0x4252574F // "BRWO"
	frameHeaderSize int64  = 12
	// maxFrameSize caps the payload length a header may claim, so a
	// corrupt length field can't make the reader allocate wildly. An
	// OpRecord is a few hundred bytes; 64 MiB is astronomically generous.
	maxFrameSize uint32 = 64 << 20
)

var crcTable = crc32.MakeTable(crc32.Castagnoli)

// encodeFileHeader returns the bytes every oplog starts with.
func encodeFileHeader() []byte {
	hdr := make([]byte, oplogHeaderSize)
	copy(hdr, oplogFileMagic)
	binary.BigEndian.PutUint32(hdr[len(oplogFileMagic):], oplogFormatVersion)
	return hdr
}

// checkFileHeader validates the first oplogHeaderSize bytes of an oplog.
// It returns an *errTornFrame when the header itself is incomplete (the
// very first append tore before anything usable landed, so the file can be
// reset), and a plain error when the header is present but says this is not
// a format this build understands.
func checkFileHeader(f *os.File, size int64) error {
	if size < oplogHeaderSize {
		return &errTornFrame{Offset: 0, Reason: fmt.Sprintf("file header is %d bytes, want %d", size, oplogHeaderSize)}
	}
	hdr := make([]byte, oplogHeaderSize)
	if _, err := f.ReadAt(hdr, 0); err != nil {
		return err
	}
	if string(hdr[:len(oplogFileMagic)]) != oplogFileMagic {
		return fmt.Errorf("not a brawt oplog: file header is %q, want %q (an oplog written before the framed/checksummed format change reads like this; brawt is pre-release and does not migrate it -- delete the bundle to start fresh)", hdr[:len(oplogFileMagic)], oplogFileMagic)
	}
	if v := binary.BigEndian.Uint32(hdr[len(oplogFileMagic):]); v != oplogFormatVersion {
		return fmt.Errorf("unsupported oplog format version %d, this build understands %d", v, oplogFormatVersion)
	}
	return nil
}

// errTornFrame reports that the frame starting at Offset is damaged. It
// says nothing about whether the damage is recoverable -- that depends on
// whether intact records follow it (see Bundle.readOplogLocked).
type errTornFrame struct {
	Offset int64
	Reason string
}

func (e *errTornFrame) Error() string {
	return fmt.Sprintf("oplog frame at offset %d is damaged: %s", e.Offset, e.Reason)
}

// encodeFrame builds the complete on-disk frame for payload in one buffer,
// so Append can hand the kernel a single Write.
func encodeFrame(payload []byte) []byte {
	frame := make([]byte, int(frameHeaderSize)+len(payload))
	binary.BigEndian.PutUint32(frame[0:4], frameMagic)
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(payload)))
	binary.BigEndian.PutUint32(frame[8:12], crc32.Checksum(payload, crcTable))
	copy(frame[frameHeaderSize:], payload)
	return frame
}

// frameReader decodes frames sequentially while tracking the byte offset of
// the next frame, which is what a repair needs in order to truncate the
// file back to the end of the last intact record.
type frameReader struct {
	br  *bufio.Reader
	off int64 // offset of the next frame to be read
}

// newFrameReader reads frames from r, whose first byte sits at offset
// startOff in the underlying file (i.e. just past the file header).
func newFrameReader(r io.Reader, startOff int64) *frameReader {
	return &frameReader{br: bufio.NewReader(r), off: startOff}
}

// next returns the payload of the next frame. It returns io.EOF at a clean
// record boundary, and *errTornFrame when the bytes at the current offset
// are not an intact frame.
func (fr *frameReader) next() ([]byte, error) {
	var hdr [12]byte
	n, err := io.ReadFull(fr.br, hdr[:])
	switch {
	case err == io.EOF && n == 0:
		return nil, io.EOF // clean end of file
	case err != nil:
		return nil, &errTornFrame{Offset: fr.off, Reason: fmt.Sprintf("header is %d bytes, want %d", n, frameHeaderSize)}
	}

	if magic := binary.BigEndian.Uint32(hdr[0:4]); magic != frameMagic {
		return nil, &errTornFrame{Offset: fr.off, Reason: fmt.Sprintf("bad magic 0x%08x, want 0x%08x", magic, frameMagic)}
	}
	length := binary.BigEndian.Uint32(hdr[4:8])
	if length > maxFrameSize {
		return nil, &errTornFrame{Offset: fr.off, Reason: fmt.Sprintf("declared payload length %d exceeds the %d byte limit", length, maxFrameSize)}
	}
	want := binary.BigEndian.Uint32(hdr[8:12])

	payload := make([]byte, length)
	if n, err := io.ReadFull(fr.br, payload); err != nil {
		return nil, &errTornFrame{Offset: fr.off, Reason: fmt.Sprintf("payload is %d bytes, header declared %d", n, length)}
	}
	if got := crc32.Checksum(payload, crcTable); got != want {
		return nil, &errTornFrame{Offset: fr.off, Reason: fmt.Sprintf("checksum mismatch: computed 0x%08x, header declared 0x%08x", got, want)}
	}

	fr.off += frameHeaderSize + int64(length)
	return payload, nil
}

// findFrameAfter scans [start, end) for an intact frame. It exists to tell
// the two damage cases apart: if nothing intact follows the damage, the
// file simply ends in a torn write and truncating back to the last good
// record repairs it; if an intact frame does follow, the damage is in the
// MIDDLE of an otherwise complete file and truncating would silently
// destroy healthy records, so it has to be reported instead.
//
// A false positive would need four magic bytes, a plausible length and a
// matching CRC-32C to line up by chance, and errs on the safe side anyway:
// it reports corruption rather than discarding data.
func findFrameAfter(f *os.File, start, end int64) bool {
	if start >= end {
		return false
	}
	br := bufio.NewReader(io.NewSectionReader(f, start, end-start))
	var window uint32
	off := start
	for {
		c, err := br.ReadByte()
		if err != nil {
			return false
		}
		window = window<<8 | uint32(c)
		off++
		if off-start >= 4 && window == frameMagic {
			if frameIsIntactAt(f, off-4, end) {
				return true
			}
		}
	}
}

// frameIsIntactAt reports whether a complete, checksum-valid frame starts
// at off and ends at or before end.
func frameIsIntactAt(f *os.File, off, end int64) bool {
	if off+frameHeaderSize > end {
		return false
	}
	var hdr [12]byte
	if _, err := f.ReadAt(hdr[:], off); err != nil {
		return false
	}
	if binary.BigEndian.Uint32(hdr[0:4]) != frameMagic {
		return false
	}
	length := binary.BigEndian.Uint32(hdr[4:8])
	if length > maxFrameSize || off+frameHeaderSize+int64(length) > end {
		return false
	}
	payload := make([]byte, length)
	if _, err := f.ReadAt(payload, off+frameHeaderSize); err != nil {
		return false
	}
	return crc32.Checksum(payload, crcTable) == binary.BigEndian.Uint32(hdr[8:12])
}

// asTornFrame extracts the *errTornFrame from err, if any.
func asTornFrame(err error) (*errTornFrame, bool) {
	var t *errTornFrame
	ok := errors.As(err, &t)
	return t, ok
}
