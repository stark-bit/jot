// Loaded with <script type="module">; the export marks this file as a module for TypeScript.
// oxlint-disable-next-line unicorn/require-module-specifiers -- intentional empty export, see above
export {};

(() => {
  const mode = document.body.dataset.authMode;
  const ownerTokenKey = window.__OWNER_TOKEN_KEY__ || "md_owner_token";
  const form = document.getElementById("auth-form");
  const errorNode = document.getElementById("auth-error");

  restoreOwnerSession().then((restored) => {
    if (restored) {
      window.location.replace("/");
      return;
    }

    form.addEventListener("submit", onSubmit);
  });

  async function onSubmit(event) {
    event.preventDefault();
    setError("");

    // TODO(ts): TS2345 Argument of type 'HTMLElement' is not assignable to parameter of type 'HTMLFormElement'.
    // @ts-expect-error
    const formData = new FormData(form);
    const body = Object.fromEntries(formData.entries());
    const endpoint = mode === "setup" ? "/api/auth/setup" : "/api/auth/login";

    try {
      const payload = await api(endpoint, { method: "POST", body });
      window.localStorage.setItem(ownerTokenKey, payload.token);
      await restoreOwnerSession();
      window.location.replace("/");
    } catch (error) {
      setError(error.message || "Request failed.");
    }
  }

  async function restoreOwnerSession() {
    const token = window.localStorage.getItem(ownerTokenKey);
    if (!token) {
      return false;
    }

    try {
      await api("/api/auth/token", { method: "POST", body: { token } });
      return true;
    } catch {
      window.localStorage.removeItem(ownerTokenKey);
      return false;
    }
  }

  async function api(url: string, options: { method?: string; body?: unknown } = {}) {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Request failed.");
    }
    return payload;
  }

  function setError(message) {
    errorNode.textContent = message;
    errorNode.classList.toggle("hidden", !message);
  }
})();
