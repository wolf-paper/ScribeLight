#[test]
fn default_capability_grants_only_the_narrow_dialog_permissions() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();

    assert_eq!(
        capability["permissions"],
        serde_json::json!(["core:default", "dialog:allow-open", "dialog:allow-save"])
    );
}
