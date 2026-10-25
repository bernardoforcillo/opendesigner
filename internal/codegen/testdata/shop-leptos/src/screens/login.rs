// Exported by opendesigner (opendesigner export): screen "Login" (route /login) of document "Shop" (shop). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.

use leptos::prelude::*;
use leptos_router::hooks::use_navigate;
use leptos_router::NavigateOptions;

#[component]
pub fn Login() -> impl IntoView {
    let navigate = use_navigate();
    view! {
        <div
            data-node-id="login"
            style="position: relative; width: 360px; height: 560px; overflow: hidden; background-color: #f7f7fc"
        >
            <div
                data-node-id="loginTitle"
                style="position: absolute; left: 24px; top: 48px; width: 312px; white-space: pre-wrap; overflow-wrap: break-word; font-family: Inter, sans-serif; font-size: 28px; font-weight: 700; line-height: 1.2; color: #1a1a1f"
            >
                "Sign in to the shop"
            </div>
            <div
                data-node-id="loginEmail"
                style="position: absolute; left: 24px; top: 120px; width: 312px; height: 48px; border-radius: 10px; background-color: #fff; box-shadow: inset 0 0 0 1px #ccccd9"
            >
            </div>
            <div
                data-node-id="loginPass"
                style="position: absolute; left: 24px; top: 184px; width: 312px; height: 48px; border-radius: 10px; background-color: #fff; box-shadow: inset 0 0 0 1px #ccccd9"
            >
            </div>
            // flow: t1
            // guard: valid credentials
            // effect: active session
            <div
                data-node-id="loginBtn"
                data-testid="login-submit"
                style="position: absolute; left: 24px; top: 264px; width: 312px; height: 52px; display: flex; justify-content: center; align-items: center; background-color: #3366f2; cursor: pointer"
                role="button"
                tabindex="0"
                aria-label="Sign in"
                on:click={let navigate = navigate.clone(); move |_| { navigate("/home", NavigateOptions::default()); }}
                on:keydown={let navigate = navigate.clone(); move |ev: web_sys::KeyboardEvent| { if ev.key() == "Enter" { navigate("/home", NavigateOptions::default()); } }}
            >
                <div
                    data-node-id="loginBtnLabel"
                    style="position: relative; flex-shrink: 0; width: 120px; white-space: pre-wrap; overflow-wrap: break-word; height: 20px; font-family: Inter, sans-serif; font-size: 16px; font-weight: 600; line-height: 1.2; text-align: center; color: #fff"
                >
                    "Sign in"
                </div>
            </div>
        </div>
    }
}
