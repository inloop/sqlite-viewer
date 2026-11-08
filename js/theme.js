"use strict";

// Theme preference: "system" (default), "light" or "dark", persisted in
// localStorage. Loaded from <head> so the resolved theme is applied to
// <html data-bs-theme> before the first paint; main.js wires up the controls.
(function () {
    const STORAGE_KEY = "sqlite_viewer_theme";
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    function getPreference() {
        try {
            const value = localStorage.getItem(STORAGE_KEY);
            if (value === "light" || value === "dark") return value;
        } catch (e) {
            // localStorage unavailable (private mode, storage blocked)
        }
        return "system";
    }

    function resolve(preference) {
        if (preference === "light" || preference === "dark") return preference;
        return media.matches ? "dark" : "light";
    }

    function apply() {
        document.documentElement.setAttribute("data-bs-theme", resolve(getPreference()));
        document.dispatchEvent(new CustomEvent("themechange", { detail: { preference: getPreference() } }));
    }

    function setPreference(preference) {
        try {
            if (preference === "system") {
                localStorage.removeItem(STORAGE_KEY);
            } else {
                localStorage.setItem(STORAGE_KEY, preference);
            }
        } catch (e) {
            // ignore: fall back to applying in-memory only
        }
        apply();
    }

    // Follow the OS while the preference is "system".
    media.addEventListener("change", () => {
        if (getPreference() === "system") apply();
    });

    window.themeControl = { getPreference, setPreference };

    apply();
})();
