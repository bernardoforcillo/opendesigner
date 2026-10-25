package mcp

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// DOCUMENTS, VERSIONS AND BRANCHES: what the Home page and the Versions dialog do. Thin wrappers over the
// server's own RPCs, so the rules (access, validation) are the server's.
//
// Left to a person on purpose: protecting a document and minting or revoking share links (EnableAccess,
// CreateShareLink, RevokeShareLink). An agent can READ the access state (get_access), not change who may open the document.

type DocView struct {
	Id        string `json:"id"`
	Name      string `json:"name"`
	UpdatedAt int64  `json:"updatedAt,omitempty" jsonschema:"unix seconds"`
	Screens   uint32 `json:"screens"`
	Flows     uint32 `json:"flows"`
	Vertical  string `json:"vertical,omitempty" jsonschema:"publishing | design | product"`
}

func docView(d *opendesignerv1.DocInfo) DocView {
	return DocView{Id: d.GetId(), Name: d.GetName(), UpdatedAt: d.GetUpdatedAt(), Screens: d.GetScreens(), Flows: d.GetFlows(), Vertical: verticalName(d.GetVertical())}
}

type ListDocumentsOutput struct {
	Documents []DocView `json:"documents"`
}

// ListDocuments lists the documents of the workspace.
func (s *Session) ListDocuments(ctx context.Context, _ struct{}) (ListDocumentsOutput, error) {
	r, err := s.client.ListDocuments(ctx, connect.NewRequest(&opendesignerv1.ListDocumentsRequest{}))
	if err != nil {
		return ListDocumentsOutput{}, fmt.Errorf("list_documents: %w", err)
	}
	out := ListDocumentsOutput{Documents: []DocView{}}
	for _, d := range r.Msg.GetDocs() {
		out.Documents = append(out.Documents, docView(d))
	}
	return out, nil
}

type CreateDocumentInput struct {
	Name     string `json:"name"`
	Vertical string `json:"vertical,omitempty" jsonschema:"publishing | design | product (default)"`
}

// CreateDocument makes a new empty document. This session stays bound to the document it was started on.
func (s *Session) CreateDocument(ctx context.Context, in CreateDocumentInput) (DocView, error) {
	v := in.Vertical
	if v == "product" {
		v = ""
	}
	r, err := s.client.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: in.Name, Vertical: v}))
	if err != nil {
		return DocView{}, fmt.Errorf("create_document: %w", err)
	}
	return docView(r.Msg), nil
}

type RenameDocumentInput struct {
	DocId string `json:"docId,omitempty" jsonschema:"default: this session's document"`
	Name  string `json:"name"`
}

// RenameDocument renames a document.
func (s *Session) RenameDocument(ctx context.Context, in RenameDocumentInput) (DocView, error) {
	r, err := s.client.RenameDocument(ctx, connect.NewRequest(&opendesignerv1.RenameDocumentRequest{DocId: s.docOr(in.DocId), Name: in.Name}))
	if err != nil {
		return DocView{}, fmt.Errorf("rename_document: %w", err)
	}
	return docView(r.Msg), nil
}

type DeleteDocumentInput struct {
	DocId   string `json:"docId" jsonschema:"the document to delete: PERMANENT, with its versions and assets. It is never defaulted to this session's document"`
	Confirm bool   `json:"confirm" jsonschema:"must be true"`
}

// DeleteDocument removes a document for good.
func (s *Session) DeleteDocument(ctx context.Context, in DeleteDocumentInput) (struct{}, error) {
	if !in.Confirm || in.DocId == "" {
		return struct{}{}, fmt.Errorf("delete_document: pass the docId and confirm: true; the deletion is permanent")
	}
	if _, err := s.client.DeleteDocument(ctx, connect.NewRequest(&opendesignerv1.DeleteDocumentRequest{DocId: in.DocId})); err != nil {
		return struct{}{}, fmt.Errorf("delete_document: %w", err)
	}
	return struct{}{}, nil
}

func (s *Session) docOr(id string) string {
	if id == "" {
		return s.docID
	}
	return id
}

type VersionView struct {
	Id        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt" jsonschema:"unix seconds"`
	Seq       uint64 `json:"seq"`
}

type ListVersionsOutput struct {
	Versions []VersionView `json:"versions" jsonschema:"newest first"`
}

// ListVersions lists the named versions of this document.
func (s *Session) ListVersions(ctx context.Context, _ struct{}) (ListVersionsOutput, error) {
	r, err := s.client.ListVersions(ctx, connect.NewRequest(&opendesignerv1.ListVersionsRequest{DocId: s.docID}))
	if err != nil {
		return ListVersionsOutput{}, fmt.Errorf("list_versions: %w", err)
	}
	out := ListVersionsOutput{Versions: []VersionView{}}
	for _, v := range r.Msg.GetVersions() {
		out.Versions = append(out.Versions, VersionView{Id: v.GetId(), Name: v.GetName(), CreatedAt: v.GetCreatedAt(), Seq: v.GetSeq()})
	}
	return out, nil
}

type CreateVersionInput struct {
	Name string `json:"name" jsonschema:"e.g. 'Before the client review'"`
}

// CreateVersion freezes a copy of the document as it is now.
func (s *Session) CreateVersion(ctx context.Context, in CreateVersionInput) (VersionView, error) {
	r, err := s.client.CreateVersion(ctx, connect.NewRequest(&opendesignerv1.CreateVersionRequest{DocId: s.docID, Name: in.Name}))
	if err != nil {
		return VersionView{}, fmt.Errorf("create_version: %w", err)
	}
	return VersionView{Id: r.Msg.GetId(), Name: r.Msg.GetName(), CreatedAt: r.Msg.GetCreatedAt(), Seq: r.Msg.GetSeq()}, nil
}

type DeleteVersionInput struct {
	VersionId string `json:"versionId"`
}

// DeleteVersion removes a named version.
func (s *Session) DeleteVersion(ctx context.Context, in DeleteVersionInput) (struct{}, error) {
	if _, err := s.client.DeleteVersion(ctx, connect.NewRequest(&opendesignerv1.DeleteVersionRequest{DocId: s.docID, VersionId: in.VersionId})); err != nil {
		return struct{}{}, fmt.Errorf("delete_version: %w", err)
	}
	return struct{}{}, nil
}

type BranchInput struct {
	VersionId string `json:"versionId,omitempty" jsonschema:"branch from this version; empty = from the document as it is now"`
	Name      string `json:"name" jsonschema:"name of the new document"`
}

// BranchDocument opens a copy as a new document that remembers where it came from.
func (s *Session) BranchDocument(ctx context.Context, in BranchInput) (DocView, error) {
	r, err := s.client.BranchDocument(ctx, connect.NewRequest(&opendesignerv1.BranchRequest{DocId: s.docID, VersionId: in.VersionId, Name: in.Name}))
	if err != nil {
		return DocView{}, fmt.Errorf("branch_document: %w", err)
	}
	return docView(r.Msg), nil
}

type BranchOriginOutput struct {
	IsBranch     bool   `json:"isBranch"`
	SourceDocId  string `json:"sourceDocId,omitempty"`
	SourceName   string `json:"sourceName,omitempty"`
	SourceExists bool   `json:"sourceExists,omitempty"`
}

// GetBranchOrigin says whether this document is a branch and of what.
func (s *Session) GetBranchOrigin(ctx context.Context, _ struct{}) (BranchOriginOutput, error) {
	r, err := s.client.GetBranchOrigin(ctx, connect.NewRequest(&opendesignerv1.GetBranchOriginRequest{DocId: s.docID}))
	if err != nil {
		return BranchOriginOutput{}, fmt.Errorf("get_branch_origin: %w", err)
	}
	return BranchOriginOutput{IsBranch: r.Msg.GetIsBranch(), SourceDocId: r.Msg.GetSourceDocId(), SourceName: r.Msg.GetSourceName(), SourceExists: r.Msg.GetSourceExists()}, nil
}

type MergeChangeView struct {
	Entity        string   `json:"entity" jsonschema:"node | page | flow | transition | clip | collection | variable | font | text_style | component_set"`
	Id            string   `json:"id"`
	Name          string   `json:"name,omitempty"`
	Kind          string   `json:"kind" jsonschema:"added | removed | changed"`
	Paths         []string `json:"paths,omitempty"`
	Conflict      bool     `json:"conflict,omitempty"`
	ConflictPaths []string `json:"conflictPaths,omitempty"`
}

type ReviewMergeOutput struct {
	SourceDocId string            `json:"sourceDocId"`
	SourceName  string            `json:"sourceName"`
	Changes     []MergeChangeView `json:"changes"`
	Warnings    []string          `json:"warnings,omitempty"`
}

// ReviewMerge lists what merging this branch back into its original would change.
func (s *Session) ReviewMerge(ctx context.Context, _ struct{}) (ReviewMergeOutput, error) {
	r, err := s.client.ReviewMerge(ctx, connect.NewRequest(&opendesignerv1.ReviewMergeRequest{DocId: s.docID}))
	if err != nil {
		return ReviewMergeOutput{}, fmt.Errorf("review_merge: %w", err)
	}
	out := ReviewMergeOutput{SourceDocId: r.Msg.GetSourceDocId(), SourceName: r.Msg.GetSourceName(), Warnings: r.Msg.GetWarnings(), Changes: []MergeChangeView{}}
	for _, c := range r.Msg.GetChanges() {
		out.Changes = append(out.Changes, MergeChangeView{Entity: c.GetEntity(), Id: c.GetId(), Name: c.GetName(), Kind: c.GetKind(), Paths: c.GetPaths(), Conflict: c.GetConflict(), ConflictPaths: c.GetConflictPaths()})
	}
	return out, nil
}

type MergeBranchInput struct {
	PreferBranch bool `json:"preferBranch,omitempty" jsonschema:"on a conflict take the branch's value (default: keep the original's)"`
}

type MergeBranchOutput struct {
	Applied          uint32 `json:"applied"`
	SkippedConflicts uint32 `json:"skippedConflicts"`
}

// MergeBranch applies this branch's changes to its original document.
func (s *Session) MergeBranch(ctx context.Context, in MergeBranchInput) (MergeBranchOutput, error) {
	r, err := s.client.MergeBranch(ctx, connect.NewRequest(&opendesignerv1.MergeBranchRequest{DocId: s.docID, PreferBranch: in.PreferBranch}))
	if err != nil {
		return MergeBranchOutput{}, fmt.Errorf("merge_branch: %w", err)
	}
	return MergeBranchOutput{Applied: r.Msg.GetApplied(), SkippedConflicts: r.Msg.GetSkippedConflicts()}, nil
}

type GetAccessOutput struct {
	Protected bool   `json:"protected" jsonschema:"false = open to anyone who can reach the server"`
	Role      string `json:"role" jsonschema:"this session's role: open | owner | edit | comment | view"`
	Links     []struct {
		Id        string `json:"id"`
		Role      string `json:"role"`
		Label     string `json:"label,omitempty"`
		CreatedAt int64  `json:"createdAt"`
	} `json:"links,omitempty" jsonschema:"the share links (owner only); the secret of a link is shown once, when a person makes it"`
}

// GetAccess reports whether the document is protected and the role this session has.
func (s *Session) GetAccess(ctx context.Context, _ struct{}) (GetAccessOutput, error) {
	r, err := s.client.GetAccess(ctx, connect.NewRequest(&opendesignerv1.GetAccessRequest{DocId: s.docID}))
	if err != nil {
		return GetAccessOutput{}, fmt.Errorf("get_access: %w", err)
	}
	out := GetAccessOutput{Protected: r.Msg.GetEnabled(), Role: r.Msg.GetRole()}
	for _, l := range r.Msg.GetLinks() {
		out.Links = append(out.Links, struct {
			Id        string `json:"id"`
			Role      string `json:"role"`
			Label     string `json:"label,omitempty"`
			CreatedAt int64  `json:"createdAt"`
		}{l.GetId(), l.GetRole(), l.GetLabel(), l.GetCreatedAt()})
	}
	return out, nil
}

func registerDocumentTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_documents", "List the documents of the workspace (id, name, screens, flows, vertical).", s.ListDocuments)
	addTool(srv, "create_document", "Create a new empty document (vertical publishing | design | product). This session keeps working on its own document; start another session to edit the new one.", s.CreateDocument)
	addTool(srv, "rename_document", "Rename a document (default: this session's).", s.RenameDocument)
	addTool(srv, "delete_document", "Delete a document PERMANENTLY, with its versions and assets. Needs the docId (never defaulted) and confirm: true.", s.DeleteDocument)
	addTool(srv, "list_versions", "List the named versions (frozen copies) of the document, newest first.", s.ListVersions)
	addTool(srv, "create_version", "Freeze a named copy of the document as it is now.", s.CreateVersion)
	addTool(srv, "delete_version", "Delete a named version.", s.DeleteVersion)
	addTool(srv, "branch_document", "Open a copy (of a version, or of the document now) as a NEW document that remembers its origin; work on it, then review_merge and merge_branch from a session on the branch.", s.BranchDocument)
	addTool(srv, "get_branch_origin", "Whether this document is a branch, and of which document.", s.GetBranchOrigin)
	addTool(srv, "review_merge", "On a branch: the property-level changes that merging it back into its original would make, with the conflicts.", s.ReviewMerge)
	addTool(srv, "merge_branch", "On a branch: apply its changes to the original (needs edit access to both). Conflicting changes keep the original's value unless preferBranch.", s.MergeBranch)
	addTool(srv, "get_access", "Whether the document is protected, the role this session has and the share links (owner only). Protecting a document and making or revoking links is left to a person in the editor.", s.GetAccess)
}
