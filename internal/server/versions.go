package server

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/bernardoforcillo/opendesigner/internal/merge"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

// NAMED VERSIONS and BRANCHES of a document (see store/versions.go). A version is a frozen
// copy; a branch is a NEW document seeded from a version (or from the current state), with
// the assets it uses, that evolves on its own.

var errNoVersionStore = errors.New("this document cannot keep versions")

func (m *Manager) bundleOf(docID string) (*Hub, *store.Bundle, error) {
	if !m.Exists(docID) {
		return nil, nil, ErrDocNotFound
	}
	h, err := m.HubFor(docID)
	if err != nil {
		return nil, nil, err
	}
	b, ok := h.versionStore()
	if !ok {
		return nil, nil, errNoVersionStore
	}
	return h, b, nil
}

func versionInfo(v store.Version) *opendesignerv1.VersionInfo {
	return &opendesignerv1.VersionInfo{Id: v.ID, Name: v.Name, CreatedAt: v.CreatedAt.Unix(), Seq: v.Seq}
}

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errEmptyName
	}
	if utf8.RuneCountInString(name) > maxNameRunes {
		return "", errNameTooLong
	}
	return name, nil
}

// CreateVersion freezes the document as it is now.
func (m *Manager) CreateVersion(docID, name string) (*opendesignerv1.VersionInfo, error) {
	name, err := cleanName(name)
	if err != nil {
		return nil, err
	}
	h, b, err := m.bundleOf(docID)
	if err != nil {
		return nil, err
	}
	doc, seq := h.Snapshot()
	v, err := b.SaveVersion(name, doc, seq)
	if err != nil {
		return nil, err
	}
	return versionInfo(v), nil
}

// ListVersions returns the saved versions, newest first.
func (m *Manager) ListVersions(docID string) ([]*opendesignerv1.VersionInfo, error) {
	_, b, err := m.bundleOf(docID)
	if err != nil {
		return nil, err
	}
	vs, err := b.ListVersions()
	if err != nil {
		return nil, err
	}
	out := make([]*opendesignerv1.VersionInfo, 0, len(vs))
	for _, v := range vs {
		out = append(out, versionInfo(v))
	}
	return out, nil
}

// DeleteVersion removes a saved version.
func (m *Manager) DeleteVersion(docID, versionID string) error {
	_, b, err := m.bundleOf(docID)
	if err != nil {
		return err
	}
	return b.DeleteVersion(versionID)
}

// Branch creates a new document seeded from a version (versionID empty = the current
// state). The new document has its own id and name, and a copy of the source's assets.
func (m *Manager) Branch(docID, versionID, name string) (*opendesignerv1.DocInfo, error) {
	name, err := cleanName(name)
	if err != nil {
		return nil, err
	}
	h, b, err := m.bundleOf(docID)
	if err != nil {
		return nil, err
	}
	var src *opendesignerv1.Document
	var seq uint64
	if versionID == "" {
		src, seq = h.Snapshot()
	} else {
		d, v, err := b.LoadVersion(versionID)
		if err != nil {
			return nil, err
		}
		src, seq = d, v.Seq
	}
	if seq == 0 {
		seq = 1 // a snapshot of seq 0 would be "no snapshot": the hub would start from an empty document
	}
	id := uuid.NewString()
	nb, err := store.Open(m.workspace, id, name)
	if err != nil {
		return nil, err
	}
	doc := proto.Clone(src).(*opendesignerv1.Document)
	doc.Id, doc.Name = id, name
	if err := nb.Snapshot(doc, seq); err != nil {
		return nil, err
	}
	// Remember where it came from, and what it looked like then: what a later merge compares against.
	srcName := src.GetName()
	if err := nb.SaveOrigin(store.Origin{SourceDocID: docID, SourceName: srcName, CreatedAt: time.Now().UTC().Truncate(time.Second), BaseSeq: seq}, doc); err != nil {
		return nil, err
	}
	if err := store.CopyAssets(m.workspace, docID, id); err != nil {
		return nil, err
	}
	nh, err := NewHub(nb)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.hubs[id] = nh
	m.mu.Unlock()
	meta := nb.Meta()
	return &opendesignerv1.DocInfo{Id: meta.ID, Name: meta.Name, UpdatedAt: meta.UpdatedAt.Unix()}, nil
}

// ---- merging a branch back ----

var errNotABranch = errors.New("this document is not a branch")

// BranchOrigin says whether docID is a branch and of which document.
func (m *Manager) BranchOrigin(docID string) (*opendesignerv1.GetBranchOriginResponse, error) {
	_, b, err := m.bundleOf(docID)
	if err != nil {
		return nil, err
	}
	o, _, err := b.LoadOrigin()
	if errors.Is(err, store.ErrNoOrigin) {
		return &opendesignerv1.GetBranchOriginResponse{}, nil
	}
	if err != nil {
		return nil, err
	}
	return &opendesignerv1.GetBranchOriginResponse{
		IsBranch: true, SourceDocId: o.SourceDocID, SourceName: o.SourceName, SourceExists: m.Exists(o.SourceDocID), CreatedAt: o.CreatedAt.Unix(),
	}, nil
}

// mergePlan compares the branch, its starting point and the original now.
func (m *Manager) mergePlan(branchID string) (store.Origin, *Hub, *merge.Plan, *store.Bundle, *opendesignerv1.Document, error) {
	bh, bb, err := m.bundleOf(branchID)
	if err != nil {
		return store.Origin{}, nil, nil, nil, nil, err
	}
	o, base, err := bb.LoadOrigin()
	if errors.Is(err, store.ErrNoOrigin) {
		return store.Origin{}, nil, nil, nil, nil, errNotABranch
	}
	if err != nil {
		return store.Origin{}, nil, nil, nil, nil, err
	}
	if !m.Exists(o.SourceDocID) {
		return store.Origin{}, nil, nil, nil, nil, fmt.Errorf("%w: the original %q is gone", ErrDocNotFound, o.SourceName)
	}
	sh, err := m.HubFor(o.SourceDocID)
	if err != nil {
		return store.Origin{}, nil, nil, nil, nil, err
	}
	branchDoc, _ := bh.Snapshot()
	sourceDoc, _ := sh.Snapshot()
	return o, sh, merge.Compute(base, branchDoc, sourceDoc), bb, branchDoc, nil
}

// ReviewMerge lists what merging the branch back would do.
func (m *Manager) ReviewMerge(branchID string) (*opendesignerv1.ReviewMergeResponse, error) {
	o, _, plan, _, _, err := m.mergePlan(branchID)
	if err != nil {
		return nil, err
	}
	out := &opendesignerv1.ReviewMergeResponse{SourceDocId: o.SourceDocID, SourceName: o.SourceName, Warnings: plan.Warnings}
	for _, c := range plan.Changes {
		out.Changes = append(out.Changes, &opendesignerv1.MergeChange{
			Entity: c.Entity, Id: c.ID, Name: c.Name, Kind: c.Kind, Paths: c.Paths, Conflict: c.Conflict, ConflictPaths: c.ConflictPaths,
		})
	}
	return out, nil
}

// MergeBranch applies the branch's changes to the original. All or nothing: the ops are checked
// against a copy of the original first, and only then submitted to it.
func (m *Manager) MergeBranch(branchID string, preferBranch bool) (*opendesignerv1.MergeBranchResponse, error) {
	o, sh, plan, bb, branchDoc, err := m.mergePlan(branchID)
	if err != nil {
		return nil, err
	}
	ops := plan.Ops(o.SourceDocID, preferBranch)
	scratch, _ := sh.Snapshot()
	scratch = proto.Clone(scratch).(*opendesignerv1.Document)
	for i, op := range ops {
		op.OpId = uuid.NewString()
		if err := core.Apply(scratch, proto.Clone(op).(*opendesignerv1.Op)); err != nil {
			return nil, fmt.Errorf("the merge would not apply (change %d): %w", i+1, err)
		}
	}
	for _, op := range ops {
		if _, err := sh.Submit("merge-"+branchID, op); err != nil {
			return nil, err
		}
	}
	// From here on the branch's state is the new common ancestor: what was merged is not offered
	// again, and a conflict resolved the original's way is not either.
	if err := bb.SaveOrigin(store.Origin{SourceDocID: o.SourceDocID, SourceName: o.SourceName, CreatedAt: time.Now().UTC().Truncate(time.Second)}, branchDoc); err != nil {
		return nil, err
	}
	skipped := 0
	if !preferBranch {
		skipped = plan.Conflicts()
	}
	return &opendesignerv1.MergeBranchResponse{Applied: uint32(len(ops)), SkippedConflicts: uint32(skipped)}, nil
}
