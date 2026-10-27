import type { Message } from "@/i18n/core";
import type { MessageKey } from "@/i18n/locales/en";

// French. MACHINE DRAFT: waiting for a native speaker's review (docs/localization.md).
// A no-break space ( ) goes before : ; ? ! and inside « ».
export const fr: Record<MessageKey, Message> = {
  "Document": "Document", "Mode": "Mode", "Open left panel": "Ouvrir le panneau de gauche", "Close left panel": "Fermer le panneau de gauche",
  "Open right panel": "Ouvrir le panneau de droite", "Close right panel": "Fermer le panneau de droite",
  "Board": "Tableau", "Design": "Conception", "Flows": "Parcours", "Develop": "Développement",
  "An infinite board: sticky notes, text and arrows": "Un tableau infini : notes adhésives, texte et flèches",
  "Draw the screens": "Dessinez les écrans",
  "Connect the screens and try the prototype": "Reliez les écrans et essayez le prototype",
  "Readiness, generated code, export": "Prêt pour le développement, code généré, export",
  "Your link does not allow editing": "Votre lien ne permet pas de modifier", "View only": "Lecture seule", "Comment only": "Commentaires seulement", "Zoom": "Zoom",
  "Tools": "Outils", "More shapes": "Plus de formes", "Animation": "Animation", "Undo": "Annuler", "Redo": "Rétablir", "Present": "Présenter",
  "Select": "Sélectionner", "Connect": "Relier", "Sticky note": "Note adhésive", "Link": "Lien", "Vote": "Voter", "Frame": "Cadre",
  "Rectangle": "Rectangle", "Ellipse": "Ellipse", "Polygon": "Polygone", "Star": "Étoile",
  "Text": "Texte", "Pen": "Plume", "Node": "Nœud", "Hand": "Main", "Comment": "Commentaire",
  "Document menu": "Menu du document", "Home": "Accueil", "New document": "Nouveau document", "Rename document": "Renommer le document",
  "Import SVG…": "Importer un SVG…", "Import .fig file…": "Importer un fichier .fig…", "experimental": "expérimental",
  "Import PDF…": "Importer un PDF…", "editable text and shapes": "texte et formes modifiables", "Import PDF as pictures…": "Importer le PDF en images…",
  "Export all pages as PDF…": "Exporter toutes les pages en PDF…",
  "Export PDF for print (with bleed)…": "Exporter un PDF pour l’impression (avec fond perdu)…", "Export all pages as EPUB": "Exporter toutes les pages en EPUB",
  "Page setup…": "Mise en page…", "Diagram (Mermaid, UML)…": "Diagramme (Mermaid, UML)…",
  "Whiteboard (sticky, table, kanban…)…": "Tableau blanc (notes, tableau, kanban…)…", "Variables…": "Variables…", "Fonts…": "Polices…",
  "Styles (paragraph, character)…": "Styles (paragraphe, caractère)…", "Versions…": "Versions…", "Share…": "Partager…", "Plugins…": "Plugins…",
  "Pixel snap {n} px": "Magnétisme au pixel {n} px", "Pixel snap off": "Magnétisme au pixel désactivé", "cycles 1 / 4 / 8 / off": "alterne 1 / 4 / 8 / non",
  "Renderer {name}": "Moteur de rendu {name}", "switch to {name}": "passer à {name}", "Document type": "Type de document", "Theme": "Thème",
  "System": "Système", "Light": "Clair", "Dark": "Sombre", "Language": "Langue", "machine draft": "brouillon automatique",
  "Kind of document": "Type de document", "Start from a template": "Partir d’un modèle", "Your documents": "Vos documents",
  "Loading documents…": "Chargement des documents…", "No documents yet": "Aucun document pour l’instant",
  "Pick a template above: in one click you get screens that are already connected, ready to try.":
    "Choisissez un modèle ci-dessus : en un clic, vous obtenez des écrans déjà reliés, prêts à tester.",
  "Cancel": "Annuler", "Join": "Rejoindre", "Paste a link to join": "Collez un lien pour rejoindre", "Link to a shared document": "Lien vers un document partagé",
  "That is not a valid opendesigner link.": "Ce n’est pas un lien opendesigner valide.",
  "Could not read the documents ({error}).": "Impossible de lire les documents ({error}).", "Open {name}": "Ouvrir {name}",
  "Size limits": "Limites de taille", "Variables": "Variables", "Transitions": "Transitions", "Stroke": "Contour", "Sizing": "Dimensionnement", "Paths": "Tracés",
  "Override": "Remplacement", "Layout": "Disposition", "Instance": "Instance", "Fill": "Remplissage", "Export": "Exporter", "Effect style": "Style d’effet",
  "Current flow": "Parcours actuel", "Corners": "Coins", "Constraints": "Contraintes", "Component": "Composant", "Arc": "Arc", "Appearance": "Apparence",
  "{n} documents": { one: "{n} document", other: "{n} documents" },
  "{n} screens": { one: "{n} écran", other: "{n} écrans" },
  "{n} flows": { one: "{n} parcours", other: "{n} parcours" },
};
