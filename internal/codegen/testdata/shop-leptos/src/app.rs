// Exported by opendesigner (opendesigner export): app routes of document "Shop" (shop). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.

use leptos::prelude::*;
use leptos_router::components::{Route, Router, Routes};
use leptos_router::path;

use crate::screens::*;

#[component]
pub fn App() -> impl IntoView {
    view! {
        <Router>
            <Routes fallback=|| "Page not found">
                // start screen: also mounted on "/"
                <Route path=path!("/") view=Login />
                <Route path=path!("/login") view=Login />
                <Route path=path!("/home") view=Home />
                <Route path=path!("/detail") view=Detail />
            </Routes>
        </Router>
    }
}
