package store

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
)

// Snapshot file framing.
//
// A snapshot is (document, seq) and the two are meaningless apart: a document
// paired with the wrong seq makes Load replay records already folded into it
// (core.ErrNodeExists, permanently unopenable) or skip records it still
// needs. They used to live in two files, snapshot.pb and snapshot.seq, each
// written atomically but committed by two independent renames -- so a crash
// between the renames left exactly that mismatch on disk, with no way for
// Load to tell.
//
// They are now one file, so the single rename that publishes it commits both
// or neither and the mismatch is unrepresentable:
//
//	magic   8 bytes  snapshotFileMagic -- tells a snapshot from any other
//	                 bytes that happen to be at that path, including a
//	                 snapshot written by the previous two-file format.
//	version uint32   big endian.
//	seq     uint64   big endian, the oplog seq this document includes up to.
//	length  uint32   big endian, payload byte count.
//	crc     uint32   big endian, CRC-32C (Castagnoli) of the payload.
//	payload          the marshalled opendesignerv1.Document.
//
// The checksum is not there to catch torn writes -- the temp-file + rename
// commit already makes a half-written snapshot unobservable -- but rot in
// place: a marshalled Document is dense enough that a single flipped byte
// usually still decodes, into a document that is quietly wrong. Reading is
// the only chance to notice.
const (
	snapshotFileMagic     = "OPENDSNP"
	snapshotFormatVersion = uint32(1)
	// magic + version + seq + length + crc
	snapshotHeaderSize = len(snapshotFileMagic) + 4 + 8 + 4 + 4
)

// encodeSnapshotFile builds the complete on-disk snapshot in one buffer, so
// the caller has a single blob to write, fsync and rename.
func encodeSnapshotFile(seq uint64, payload []byte) []byte {
	buf := make([]byte, snapshotHeaderSize+len(payload))
	n := copy(buf, snapshotFileMagic)
	binary.BigEndian.PutUint32(buf[n:], snapshotFormatVersion)
	binary.BigEndian.PutUint64(buf[n+4:], seq)
	binary.BigEndian.PutUint32(buf[n+12:], uint32(len(payload)))
	binary.BigEndian.PutUint32(buf[n+16:], crc32.Checksum(payload, crcTable))
	copy(buf[snapshotHeaderSize:], payload)
	return buf
}

// decodeSnapshotFile returns the seq and the marshalled Document held in
// data. Every failure is reported: a snapshot that cannot be trusted must
// never be silently downgraded to "no snapshot" (which would replay the
// oplog from zero on top of nothing) or to seq 0 (which would replay records
// the document already contains).
func decodeSnapshotFile(data []byte) (uint64, []byte, error) {
	if len(data) < snapshotHeaderSize {
		return 0, nil, fmt.Errorf("snapshot file is %d bytes, too short to hold its %d byte header", len(data), snapshotHeaderSize)
	}
	n := len(snapshotFileMagic)
	if string(data[:n]) != snapshotFileMagic {
		return 0, nil, fmt.Errorf("not a opendesigner snapshot: file header is %q, want %q (a snapshot written before the single-file format change reads like this; opendesigner is pre-release and does not migrate it -- delete snapshot.pb and snapshot.seq to rebuild from the oplog)", data[:n], snapshotFileMagic)
	}
	if v := binary.BigEndian.Uint32(data[n:]); v != snapshotFormatVersion {
		return 0, nil, fmt.Errorf("unsupported snapshot format version %d, this build understands %d", v, snapshotFormatVersion)
	}
	seq := binary.BigEndian.Uint64(data[n+4:])
	length := binary.BigEndian.Uint32(data[n+12:])
	want := binary.BigEndian.Uint32(data[n+16:])

	payload := data[snapshotHeaderSize:]
	if uint64(len(payload)) != uint64(length) {
		return 0, nil, fmt.Errorf("snapshot file declares %d payload bytes but holds %d", length, len(payload))
	}
	if got := crc32.Checksum(payload, crcTable); got != want {
		return 0, nil, fmt.Errorf("snapshot checksum mismatch: computed 0x%08x, header declared 0x%08x", got, want)
	}
	return seq, payload, nil
}
