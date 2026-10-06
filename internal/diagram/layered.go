package diagram

import "sort"

// LAYERED layout (Sugiyama style, short version), shared by
// flowchart, class and state diagrams:
//
//  1. back edges are reversed with a DFS, so the graph is a DAG;
//  2. every node goes to the level of its longest path from the entry;
//  3. edges that skip levels pass through dummy nodes, one per level;
//  4. the order within a level improves with the barycenter of the neighbors;
//  5. the cross positions pull each node toward its neighbors without overlapping them.
//
// Deterministic: same input, same bytes (no map iteration).

// Dir is the flow direction.
type Dir int

const (
	DirTD Dir = iota
	DirBT
	DirLR
	DirRL
)

func (d Dir) vertical() bool { return d == DirTD || d == DirBT }

type lnode struct{ W, H float64 }

// ledge is an edge to be represented; Top/Bottom say which end comes
// "first" in the flow (normally From -> To, but classes decide it by
// semantics: the parent sits on top even if the arrow points upward).
type ledge struct{ From, To int }

type layoutResult struct {
	Pos   []Pt   // top-left corner of each node
	Paths [][]Pt // per edge: from the center of From to the center of To, through the dummy nodes; nil for self-loops
}

func layered(nodes []lnode, edges []ledge, dir Dir, nodeGap, rankGap float64) layoutResult {
	n := len(nodes)
	vertical := dir.vertical()

	out := make([][]int, n)
	for _, e := range edges {
		if e.From != e.To {
			out[e.From] = append(out[e.From], e.To)
		}
	}
	// 1. cycles
	state := make([]int, n)
	back := map[[2]int]bool{}
	var visit func(u int)
	visit = func(u int) {
		state[u] = 1
		for _, v := range out[u] {
			switch state[v] {
			case 1:
				back[[2]int{u, v}] = true
			case 0:
				visit(v)
			}
		}
		state[u] = 2
	}
	hasIn := make([]bool, n)
	for _, e := range edges {
		if e.From != e.To {
			hasIn[e.To] = true
		}
	}
	for i := 0; i < n; i++ {
		if !hasIn[i] && state[i] == 0 {
			visit(i)
		}
	}
	for i := 0; i < n; i++ {
		if state[i] == 0 {
			visit(i)
		}
	}

	type pair [2]int
	var dag []pair
	seen := map[pair]bool{}
	for _, e := range edges {
		if e.From == e.To {
			continue
		}
		a, b := e.From, e.To
		if back[[2]int{a, b}] {
			a, b = b, a
		}
		if !seen[pair{a, b}] {
			seen[pair{a, b}] = true
			dag = append(dag, pair{a, b})
		}
	}

	// 2. levels
	rank := make([]int, n)
	indeg := make([]int, n)
	succ := make([][]int, n)
	for _, p := range dag {
		indeg[p[1]]++
		succ[p[0]] = append(succ[p[0]], p[1])
	}
	var queue []int
	for i := 0; i < n; i++ {
		if indeg[i] == 0 {
			queue = append(queue, i)
		}
	}
	for q := 0; q < len(queue); q++ {
		u := queue[q]
		for _, v := range succ[u] {
			if rank[u]+1 > rank[v] {
				rank[v] = rank[u] + 1
			}
			indeg[v]--
			if indeg[v] == 0 {
				queue = append(queue, v)
			}
		}
	}

	// 3. elements: real nodes have index < n, dummy ones >= n
	type item struct {
		rank          int
		across, along float64
		pos           int
	}
	items := make([]item, n)
	for i, nd := range nodes {
		a, l := nd.W, nd.H
		if !vertical {
			a, l = nd.H, nd.W
		}
		items[i] = item{rank: rank[i], across: a, along: l}
	}
	nbrUp := make([][]int, n)
	nbrDown := make([][]int, n)
	link := func(a, b int) {
		for len(nbrDown) <= a || len(nbrDown) <= b {
			nbrDown = append(nbrDown, nil)
			nbrUp = append(nbrUp, nil)
		}
		nbrDown[a] = append(nbrDown[a], b)
		nbrUp[b] = append(nbrUp[b], a)
	}
	chains := map[pair][]int{}
	for _, p := range dag {
		chain := []int{p[0]}
		for r := rank[p[0]] + 1; r < rank[p[1]]; r++ {
			items = append(items, item{rank: r, across: 8})
			chain = append(chain, len(items)-1)
		}
		chain = append(chain, p[1])
		for len(nbrDown) < len(items) {
			nbrDown = append(nbrDown, nil)
			nbrUp = append(nbrUp, nil)
		}
		for i := 0; i+1 < len(chain); i++ {
			link(chain[i], chain[i+1])
		}
		chains[p] = chain
	}
	for len(nbrDown) < len(items) {
		nbrDown = append(nbrDown, nil)
		nbrUp = append(nbrUp, nil)
	}
	nrank := 0
	for _, it := range items {
		if it.rank+1 > nrank {
			nrank = it.rank + 1
		}
	}
	layers := make([][]int, nrank)
	for i, it := range items {
		layers[it.rank] = append(layers[it.rank], i)
	}
	renumber := func() {
		for _, L := range layers {
			for i, k := range L {
				items[k].pos = i
			}
		}
	}
	renumber()

	// 4. order
	sweep := func(down bool) {
		for ri := 0; ri < nrank; ri++ {
			r := ri
			if !down {
				r = nrank - 1 - ri
			}
			if (down && r == 0) || (!down && r == nrank-1) {
				continue
			}
			nb := nbrUp
			if !down {
				nb = nbrDown
			}
			L := layers[r]
			bary := map[int]float64{}
			for _, k := range L {
				ns := nb[k]
				if len(ns) == 0 {
					bary[k] = float64(items[k].pos)
					continue
				}
				s := 0.0
				for _, m := range ns {
					s += float64(items[m].pos)
				}
				bary[k] = s / float64(len(ns))
			}
			sort.SliceStable(L, func(i, j int) bool { return bary[L[i]] < bary[L[j]] })
			for i, k := range L {
				items[k].pos = i
			}
		}
	}
	for i := 0; i < 4; i++ {
		sweep(true)
		sweep(false)
	}

	// 5. cross positions
	cross := make([]float64, len(items))
	for _, L := range layers {
		x := 0.0
		for _, k := range L {
			cross[k] = x + items[k].across/2
			x += items[k].across + nodeGap
		}
		total := x - nodeGap
		for _, k := range L {
			cross[k] -= total / 2
		}
	}
	relax := func(down bool) {
		for ri := 0; ri < nrank; ri++ {
			r := ri
			if !down {
				r = nrank - 1 - ri
			}
			L := layers[r]
			if len(L) == 0 {
				continue
			}
			nb := nbrUp
			if !down {
				nb = nbrDown
			}
			want := make([]float64, len(L))
			for i, k := range L {
				if ns := nb[k]; len(ns) > 0 {
					s := 0.0
					for _, m := range ns {
						s += cross[m]
					}
					want[i] = s / float64(len(ns))
				} else {
					want[i] = cross[k]
				}
			}
			left := make([]float64, len(L))
			for i := range L {
				v := want[i]
				if i > 0 {
					if min := left[i-1] + (items[L[i-1]].across+items[L[i]].across)/2 + nodeGap; v < min {
						v = min
					}
				}
				left[i] = v
			}
			right := make([]float64, len(L))
			for i := len(L) - 1; i >= 0; i-- {
				v := want[i]
				if i < len(L)-1 {
					if max := right[i+1] - (items[L[i+1]].across+items[L[i]].across)/2 - nodeGap; v > max {
						v = max
					}
				}
				right[i] = v
			}
			for i, k := range L {
				cross[k] = (left[i] + right[i]) / 2
			}
		}
	}
	for i := 0; i < 3; i++ {
		relax(true)
		relax(false)
	}

	// along the levels
	along := make([]float64, nrank)
	acc := 0.0
	for r := 0; r < nrank; r++ {
		h := 0.0
		for _, k := range layers[r] {
			if items[k].along > h {
				h = items[k].along
			}
		}
		along[r] = acc + h/2
		acc += h + rankGap
	}
	total := acc - rankGap
	if total < 0 {
		total = 0
	}

	centre := func(k int) Pt {
		a := along[items[k].rank]
		c := cross[k]
		bx, by := a, a
		if dir == DirRL {
			bx = total - a
		}
		if dir == DirBT {
			by = total - a
		}
		if vertical {
			return Pt{c, by}
		}
		return Pt{bx, c}
	}

	res := layoutResult{Pos: make([]Pt, n), Paths: make([][]Pt, len(edges))}
	for i, nd := range nodes {
		c := centre(i)
		res.Pos[i] = Pt{c.X - nd.W/2, c.Y - nd.H/2}
	}
	for ei, e := range edges {
		if e.From == e.To {
			continue
		}
		a, b := e.From, e.To
		rev := back[[2]int{a, b}]
		if rev {
			a, b = b, a
		}
		chain := append([]int(nil), chains[pair{a, b}]...)
		if rev {
			for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
				chain[i], chain[j] = chain[j], chain[i]
			}
		}
		pts := make([]Pt, len(chain))
		for i, k := range chain {
			pts[i] = centre(k)
		}
		res.Paths[ei] = pts
	}
	return res
}
