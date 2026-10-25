// Exported by opendesigner (opendesigner export): screen "Home" (route /home) of document "Shop" (shop). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.

use leptos::prelude::*;
use leptos_router::hooks::use_navigate;
use leptos_router::NavigateOptions;

#[component]
pub fn Home() -> impl IntoView {
    let navigate = use_navigate();
    view! {
        <div
            data-node-id="home"
            style="position: relative; width: 360px; height: 560px; overflow: hidden; background-color: #f7f7fc"
        >
            <div
                data-node-id="homeTitle"
                style="position: absolute; left: 24px; top: 48px; width: 312px; white-space: pre-wrap; overflow-wrap: break-word; font-family: Inter, sans-serif; font-size: 24px; font-weight: 700; line-height: 1.2; color: #1a1a1f"
            >
                "Storefront"
            </div>
            // flow: t2
            <div
                data-node-id="homeCard"
                style="position: absolute; left: 24px; top: 112px; width: 312px; height: 160px; display: flex; flex-direction: column; justify-content: flex-start; align-items: flex-start; gap: 8px; padding: 16px; background-color: #fff; box-shadow: 0 0 0 0.5px #e0e0eb,inset 0 0 0 0.5px #e0e0eb,0 4px 12px rgba(0,0,0,0.12); cursor: pointer"
                role="button"
                tabindex="0"
                aria-label="Open detail"
                on:click={let navigate = navigate.clone(); move |_| { navigate("/detail", NavigateOptions::default()); }}
                on:keydown={let navigate = navigate.clone(); move |ev: web_sys::KeyboardEvent| { if ev.key() == "Enter" { navigate("/detail", NavigateOptions::default()); } }}
            >
                <div
                    data-node-id="homeCardName"
                    style="position: relative; flex-shrink: 0; width: 280px; white-space: pre-wrap; overflow-wrap: break-word; height: 24px; font-family: Inter, sans-serif; font-size: 18px; font-weight: 600; line-height: 1.2; color: #1a1a1f"
                >
                    "Wireless headphones"
                </div>
                <div
                    data-node-id="homeCardPrice"
                    style="position: relative; flex-shrink: 0; width: 280px; white-space: pre-wrap; overflow-wrap: break-word; height: 20px; font-family: Inter, sans-serif; font-size: 14px; font-weight: 400; line-height: 1.2; color: #666673"
                >
                    "89.00 EUR"
                </div>
                <div
                    data-node-id="homeCardImg"
                    role="img"
                    aria-label="Photo"
                    style="position: relative; flex-shrink: 0; width: 280px; height: 72px; background-color: rgba(0,0,0,0.06); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.35)"
                >
                    <svg
                        width="280"
                        height="72"
                        aria-hidden="true"
                        style="position: absolute; left: 0; top: 0; max-width: none"
                    >
                        <path d="M0 0L280 72M280 0L0 72" fill="none" stroke="rgba(0,0,0,0.35)">
                        </path>
                    </svg>
                </div>
            </div>
            <div
                data-node-id="homeNote"
                style="position: absolute; left: 24px; top: 300px; width: 312px; white-space: pre-wrap; overflow-wrap: break-word; font-family: Inter, sans-serif; font-size: 13px; font-weight: 400; line-height: 1.2; color: #666673"
            >
                "Tap a product for details"
            </div>
            <nav style="position: absolute; left: 0; top: 0; z-index: 50; display: flex; flex-direction: column; opacity: 0" aria-label="Flow navigation">
                // flow: t3
                <button type="button" style="display: block; width: 1px; height: 1px; overflow: hidden; padding: 0; border: 0" on:click={let navigate = navigate.clone(); move |_| { navigate("/login", NavigateOptions::default()); }}>"Sign out"</button>
            </nav>
        </div>
    }
}
