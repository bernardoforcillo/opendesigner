package server

import (
	"sync"
	"unicode/utf8"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// Limiti d'ingresso. Il server sta su una rete di fiducia (LAN) ma non per
// questo deve accettare un nickname da un megabyte o una selezione infinita:
// ogni update viene copiato e ritrasmesso a tutti.
const (
	maxNicknameRunes = 32
	maxSelectionIDs  = 1000
	presenceChanCap  = 256
	defaultNickname  = "Ospite"
)

// presenceRoom tiene chi sta guardando UN documento. È effimera di proposito:
// non scrive sull'op-log, non sopravvive al processo, e un peer esiste finché
// ha uno stream WatchPresence aperto -- niente timeout da tarare, niente
// "fantasmi" dopo una chiusura di scheda.
type presenceRoom struct {
	mu       sync.Mutex
	peers    map[string]*opendesignerv1.PresenceState // per client_id
	watchers map[*presenceWatcher]struct{}
}

type presenceWatcher struct {
	clientID string
	ch       chan *opendesignerv1.PresenceEvent
}

func newPresenceRoom() *presenceRoom {
	return &presenceRoom{
		peers:    map[string]*opendesignerv1.PresenceState{},
		watchers: map[*presenceWatcher]struct{}{},
	}
}

func cleanNickname(n string) string {
	if utf8.RuneCountInString(n) > maxNicknameRunes {
		r := []rune(n)
		n = string(r[:maxNicknameRunes])
	}
	if n == "" {
		return defaultNickname
	}
	return n
}

// join registra un client e ritorna il canale degli eventi (già riempito con
// chi c'era prima di lui) e la funzione per uscire. Entrare e annunciarsi agli
// altri avviene nello stesso passo sotto lock, quindi nessun update può cadere
// fra "elenco iniziale" e "live".
func (r *presenceRoom) join(clientID, nickname string) (<-chan *opendesignerv1.PresenceEvent, func()) {
	r.mu.Lock()
	defer r.mu.Unlock()

	w := &presenceWatcher{clientID: clientID, ch: make(chan *opendesignerv1.PresenceEvent, presenceChanCap)}
	// L'elenco iniziale: tutti gli altri peer. Il canale ha capienza per
	// l'elenco solo se i peer sono pochi -- è una stanza di design, non un
	// concerto -- e ciò che non ci sta si perde in silenzio, come ogni update.
	for id, st := range r.peers {
		if id == clientID {
			continue
		}
		r.sendLocked(w, &opendesignerv1.PresenceEvent{Kind: &opendesignerv1.PresenceEvent_Update{Update: proto.Clone(st).(*opendesignerv1.PresenceState)}})
	}
	st := &opendesignerv1.PresenceState{ClientId: clientID, Nickname: cleanNickname(nickname)}
	r.peers[clientID] = st
	r.watchers[w] = struct{}{}
	r.broadcastLocked(clientID, &opendesignerv1.PresenceEvent{Kind: &opendesignerv1.PresenceEvent_Update{Update: proto.Clone(st).(*opendesignerv1.PresenceState)}})

	var once sync.Once
	leave := func() {
		once.Do(func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			delete(r.watchers, w)
			// Lo stesso client può avere un secondo stream (riconnessione che
			// precede la chiusura del vecchio): il peer se ne va solo quando
			// non resta nessuno stream suo.
			for other := range r.watchers {
				if other.clientID == clientID {
					return
				}
			}
			delete(r.peers, clientID)
			r.broadcastLocked(clientID, &opendesignerv1.PresenceEvent{Kind: &opendesignerv1.PresenceEvent_LeftClientId{LeftClientId: clientID}})
		})
	}
	return w.ch, leave
}

// update applica cursore/selezione/pagina di un client già entrato. Il
// nickname NON si cambia da qui: l'ha fissato join, e un update non può
// spacciarsi per un altro. Ritorna false per un client sconosciuto.
func (r *presenceRoom) update(in *opendesignerv1.PresenceState) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur, ok := r.peers[in.GetClientId()]
	if !ok {
		return false
	}
	sel := in.GetSelection()
	if len(sel) > maxSelectionIDs {
		sel = sel[:maxSelectionIDs]
	}
	cur.HasCursor = in.GetHasCursor()
	cur.CursorX = in.GetCursorX()
	cur.CursorY = in.GetCursorY()
	cur.PageId = in.GetPageId()
	cur.Selection = append([]string(nil), sel...)
	r.broadcastLocked(cur.GetClientId(), &opendesignerv1.PresenceEvent{Kind: &opendesignerv1.PresenceEvent_Update{Update: proto.Clone(cur).(*opendesignerv1.PresenceState)}})
	return true
}

// broadcastLocked manda l'evento a tutti tranne a chi l'ha generato (non ha
// bisogno di sapere dove ha il proprio cursore).
func (r *presenceRoom) broadcastLocked(from string, ev *opendesignerv1.PresenceEvent) {
	for w := range r.watchers {
		if w.clientID == from {
			continue
		}
		r.sendLocked(w, ev)
	}
}

// sendLocked non blocca mai: la presenza è lossy per costruzione (il prossimo
// update rimpiazza il precedente), quindi un watcher lento salta un evento
// invece di fermare chi scrive.
func (r *presenceRoom) sendLocked(w *presenceWatcher, ev *opendesignerv1.PresenceEvent) {
	select {
	case w.ch <- ev:
	default:
	}
}
