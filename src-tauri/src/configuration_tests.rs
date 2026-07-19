#[test]
fn default_capability_grants_only_the_narrow_dialog_permissions() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();

    assert_eq!(
        capability["permissions"],
        serde_json::json!([
            "core:default",
            "core:window:allow-destroy",
            "dialog:allow-open",
            "dialog:allow-save"
        ])
    );
}

#[test]
fn desktop_csp_is_restrictive_and_allows_only_local_ui_and_tauri_ipc() {
    let configuration: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let csp = configuration["app"]["security"]["csp"]
        .as_str()
        .expect("production CSP must be configured");
    let directives: std::collections::HashMap<_, _> = csp
        .split(';')
        .map(str::trim)
        .filter(|directive| !directive.is_empty())
        .map(|directive| {
            let (name, sources) = directive
                .split_once(' ')
                .expect("every CSP directive must have an explicit source");
            (name, sources)
        })
        .collect();

    assert_eq!(directives.get("default-src"), Some(&"'self'"));
    assert_eq!(directives.get("script-src"), Some(&"'self'"));
    assert_eq!(directives.get("style-src"), Some(&"'self' 'unsafe-inline'"));
    assert_eq!(
        directives.get("connect-src"),
        Some(&"'self' ipc: http://ipc.localhost")
    );
    assert_eq!(directives.get("img-src"), Some(&"'self'"));
    assert_eq!(directives.get("font-src"), Some(&"'self'"));
    for directive in [
        "object-src",
        "media-src",
        "frame-src",
        "frame-ancestors",
        "form-action",
    ] {
        assert_eq!(directives.get(directive), Some(&"'none'"));
    }
    assert_eq!(directives.get("base-uri"), Some(&"'none'"));
    assert_eq!(directives.len(), 12);
    for forbidden in ["https:", "ws:", "wss:", "blob:", "data:", "asset:"] {
        assert!(!csp
            .split(|character: char| character.is_ascii_whitespace() || character == ';')
            .any(|source| source == forbidden));
    }
    assert_eq!(
        csp.split(|character: char| character.is_ascii_whitespace() || character == ';')
            .filter(|source| source.starts_with("http:"))
            .collect::<Vec<_>>(),
        vec!["http://ipc.localhost"]
    );
    assert_eq!(csp.matches("'unsafe-inline'").count(), 1);
    assert!(!csp.contains("'unsafe-eval'"));
}

#[test]
fn opener_is_absent_from_frontend_and_native_dependency_manifests() {
    let package: serde_json::Value =
        serde_json::from_str(include_str!("../../package.json")).unwrap();
    assert!(package["dependencies"]["@tauri-apps/plugin-opener"].is_null());

    for manifest in [
        include_str!("../Cargo.toml"),
        include_str!("../Cargo.lock"),
        include_str!("../../bun.lock"),
        include_str!("lib.rs"),
        include_str!("../tauri.conf.json"),
    ] {
        assert!(!manifest.contains("tauri-plugin-opener"));
        assert!(!manifest.contains("@tauri-apps/plugin-opener"));
    }
}
