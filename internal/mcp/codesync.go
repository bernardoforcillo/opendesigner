package mcp

import (
	"context"
	"fmt"
	"sort"

	"connectrpc.com/connect"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/proto"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"github.com/bernardoforcillo/opendesigner/internal/codesync"
)

// CODE SYNC tools: map components and screens to the files that implement them in a code project
// and report drift between the document and that code (docs/code-sync.md). The mapping is node meta
// (code.file, code.hash), the comparison is internal/codesync against a fresh export.

type MapComponentCodeInput struct {
	NodeId string `json:"nodeId" jsonschema:"a screen frame, a component master, or any node of a component set"`
	File   string `json:"file,omitempty" jsonschema:"the implementing file, relative to the code project root (e.g. src/ui/Button.tsx); empty removes the mapping"`
}

type MapComponentCodeOutput struct {
	NodeId string `json:"nodeId"`
	File   string `json:"file,omitempty"`
	Seq    uint64 `json:"seq"`
}

func (s *Session) MapComponentCode(ctx context.Context, in MapComponentCodeInput) (MapComponentCodeOutput, error) {
	if in.File == "" {
		out, err := s.SetNodeMeta(ctx, SetNodeMetaInput{Id: in.NodeId, Unset: []string{codesync.MetaFile, codesync.MetaHash}})
		if err != nil {
			return MapComponentCodeOutput{}, fmt.Errorf("map_component_code: %w", err)
		}
		return MapComponentCodeOutput{NodeId: in.NodeId, Seq: out.Seq}, nil
	}
	file, err := codesync.Clean(in.File)
	if err != nil {
		return MapComponentCodeOutput{}, fmt.Errorf("map_component_code: %w", err)
	}
	// A new file means a new baseline: the old hash described another file.
	out, err := s.SetNodeMeta(ctx, SetNodeMetaInput{Id: in.NodeId, Meta: map[string]string{codesync.MetaFile: file}, Unset: []string{codesync.MetaHash}})
	if err != nil {
		return MapComponentCodeOutput{}, fmt.Errorf("map_component_code: %w", err)
	}
	return MapComponentCodeOutput{NodeId: in.NodeId, File: file, Seq: out.Seq}, nil
}

type CheckCodeSyncInput struct {
	Dir    string `json:"dir" jsonschema:"the code project root the mapped files are relative to"`
	Target string `json:"target,omitempty" jsonschema:"react (default) or html: what the design is exported as for the comparison"`
}

// CheckCodeSyncOutput is codesync.Report plus a count.
type CheckCodeSyncOutput struct {
	Drift    int                 `json:"drift" jsonschema:"how many mapped nodes are not in sync"`
	Entries  []codesync.Entry    `json:"entries"`
	Unmapped []codesync.Unmapped `json:"unmapped" jsonschema:"components the export writes a file for that nothing maps to (map_component_code)"`
}

func (s *Session) codeSyncReport(ctx context.Context, dir, target string) (*codesync.Report, error) {
	if dir == "" {
		return nil, fmt.Errorf("dir is required")
	}
	if target == "" {
		target = string(codegen.TargetReact)
	}
	if target != string(codegen.TargetReact) && target != string(codegen.TargetHTML) {
		return nil, fmt.Errorf("target must be react or html, not %q", target)
	}
	resp, err := s.client.ExportCode(ctx, connect.NewRequest(&opendesignerv1.ExportCodeRequest{DocId: s.docID, Target: target}))
	if err != nil {
		return nil, err
	}
	var files []codegen.File
	for _, f := range resp.Msg.GetFiles() {
		files = append(files, codegen.File{Path: f.GetPath(), Content: f.GetContent()})
	}
	s.mu.Lock()
	doc := proto.Clone(s.doc).(*opendesignerv1.Document)
	s.mu.Unlock()
	return codesync.Check(doc, files, codesync.DirReader(dir)), nil
}

func (s *Session) CheckCodeSync(ctx context.Context, in CheckCodeSyncInput) (CheckCodeSyncOutput, error) {
	rep, err := s.codeSyncReport(ctx, in.Dir, in.Target)
	if err != nil {
		return CheckCodeSyncOutput{}, fmt.Errorf("check_code_sync: %w", err)
	}
	return CheckCodeSyncOutput{Drift: rep.Drift(), Entries: rep.Entries, Unmapped: rep.Unmapped}, nil
}

type AcceptCodeSyncInput struct {
	Dir     string   `json:"dir" jsonschema:"the code project root"`
	Target  string   `json:"target,omitempty" jsonschema:"react (default) or html"`
	NodeIds []string `json:"nodeIds,omitempty" jsonschema:"only these mapped nodes; empty = every mapped node whose file exists"`
}

type AcceptCodeSyncOutput struct {
	Accepted []string `json:"accepted" jsonschema:"node ids whose baseline (code.hash) now is the current export"`
	Seq      uint64   `json:"seq,omitempty"`
}

// AcceptCodeSync records the current export as the baseline of each node, after the person has
// reconciled the two sides: from then on design-changed / code-changed say which side moved next.
func (s *Session) AcceptCodeSync(ctx context.Context, in AcceptCodeSyncInput) (AcceptCodeSyncOutput, error) {
	rep, err := s.codeSyncReport(ctx, in.Dir, in.Target)
	if err != nil {
		return AcceptCodeSyncOutput{}, fmt.Errorf("accept_code_sync: %w", err)
	}
	want := map[string]bool{}
	for _, id := range in.NodeIds {
		want[id] = true
	}
	out := AcceptCodeSyncOutput{Accepted: []string{}}
	var ids []string
	for _, e := range rep.Entries {
		if (len(want) > 0 && !want[e.NodeID]) || e.DesignHash == "" || e.Status == codesync.Missing {
			continue
		}
		ids = append(ids, e.NodeID)
		if e.Baseline == e.DesignHash {
			out.Accepted = append(out.Accepted, e.NodeID)
			continue
		}
		r, err := s.SetNodeMeta(ctx, SetNodeMetaInput{Id: e.NodeID, Meta: map[string]string{codesync.MetaHash: e.DesignHash}})
		if err != nil {
			return out, fmt.Errorf("accept_code_sync: %w", err)
		}
		out.Seq = r.Seq
		out.Accepted = append(out.Accepted, e.NodeID)
	}
	for id := range want {
		found := false
		for _, x := range ids {
			found = found || x == id
		}
		if !found {
			return out, fmt.Errorf("accept_code_sync: node %q is not a mapped node with an existing file (check_code_sync)", id)
		}
	}
	sort.Strings(out.Accepted)
	return out, nil
}

func registerCodeSyncTools(srv *mcp.Server, s *Session) {
	addTool(srv, "map_component_code", "Map a component (any node of its variant set or master), or a screen frame, to the file that implements it in a code project: sets meta code.file, in the manner of Code Connect. An empty file removes the mapping. See check_code_sync.", s.MapComponentCode)
	addTool(srv, "check_code_sync", "Detect drift between the design and the code: exports the document now and compares each mapped node's file under dir with the export. Status per node: in-sync, design-changed (the design moved since the baseline), code-changed (the code was edited), diverged (both), drifted (differ, no baseline yet), missing (no such file), not-exported. Also lists the components nothing maps to.", s.CheckCodeSync)
	addTool(srv, "accept_code_sync", "After reconciling design and code (regenerate the file, or port the change), record the current export as the baseline (meta code.hash) of the mapped nodes, so the next check can tell which side moved.", s.AcceptCodeSync)
}
