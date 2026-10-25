// Exported by opendesigner (opendesigner export): screen "Detail" (route /detail) of document "Shop" (shop). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.

use leptos::prelude::*;
use leptos_router::hooks::use_navigate;
use leptos_router::NavigateOptions;

#[component]
pub fn Detail() -> impl IntoView {
    let navigate = use_navigate();
    view! {
        <div
            data-node-id="detail"
            style="position: relative; width: 360px; height: 560px; overflow: hidden; background-color: #f7f7fc"
        >
            // flow: t4
            <div
                data-node-id="detailBack"
                style="position: absolute; left: 24px; top: 40px; width: 80px; height: 32px; border-radius: 16px; background-color: #e5e5f0; cursor: pointer"
                role="button"
                tabindex="0"
                aria-label="Back"
                on:click={let navigate = navigate.clone(); move |_| { navigate("/home", NavigateOptions::default()); }}
                on:keydown={let navigate = navigate.clone(); move |ev: web_sys::KeyboardEvent| { if ev.key() == "Enter" { navigate("/home", NavigateOptions::default()); } }}
            >
            </div>
            <div
                data-node-id="detailTitle"
                style="position: absolute; left: 24px; top: 96px; width: 312px; white-space: pre-wrap; overflow-wrap: break-word; font-family: Inter, sans-serif; font-size: 24px; font-weight: 700; line-height: 1.2; color: #1a1a1f"
            >
                "Wireless headphones"
            </div>
            <div
                data-node-id="detailBody"
                style="position: absolute; left: 24px; top: 144px; width: 312px; white-space: pre-wrap; overflow-wrap: break-word; font-family: Inter, sans-serif; font-size: 15px; font-weight: 400; line-height: 1.2; color: #4d4d59"
            >
                "Noise cancellation, 30 hours of battery life and fast charging."
            </div>
        </div>
    }
}
