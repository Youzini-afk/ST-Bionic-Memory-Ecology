use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutNode {
    x: f64,
    y: f64,
    #[serde(default)]
    vx: f64,
    #[serde(default)]
    vy: f64,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    radius: f64,
    #[serde(default)]
    region_key: String,
    #[serde(default)]
    region_rect: RegionRect,
}

fn solve_hydrate_records_in_rust(payload: HydrateRecordsPayload) -> HydrateRecordsResult {
    let nodes = clone_hydrate_records(payload.nodes);
    let edges = clone_hydrate_records(payload.edges);
    let node_count = nodes.len();
    let edge_count = edges.len();
    HydrateRecordsResult {
        ok: true,
        used_native: true,
        nodes,
        edges,
        diagnostics: HydrateRecordsDiagnostics {
            solver: "rust-wasm".to_string(),
            node_count,
            edge_count,
            records_normalized: payload.records_normalized,
        },
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutEdge {
    from: usize,
    to: usize,
    #[serde(default = "default_strength")]
    strength: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutConfig {
    #[serde(default = "default_iterations")]
    iterations: u32,
    #[serde(default = "default_repulsion")]
    repulsion: f64,
    #[serde(default = "default_spring_k")]
    spring_k: f64,
    #[serde(default = "default_damping")]
    damping: f64,
    #[serde(default = "default_center_gravity")]
    center_gravity: f64,
    #[serde(default = "default_min_gap")]
    min_gap: f64,
    #[serde(default = "default_speed_cap")]
    speed_cap: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutPayload {
    #[serde(default)]
    nodes: Vec<LayoutNode>,
    #[serde(default)]
    edges: Vec<LayoutEdge>,
    #[serde(default)]
    config: Option<LayoutConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegionRect {
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    #[serde(default)]
    w: f64,
    #[serde(default)]
    h: f64,
}

impl Default for RegionRect {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayoutDiagnostics {
    solver: String,
    node_count: usize,
    edge_count: usize,
    iterations: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayoutResult {
    ok: bool,
    used_native: bool,
    positions: Vec<f32>,
    diagnostics: LayoutDiagnostics,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistSnapshot {
    #[serde(default)]
    meta: JsonMap<String, JsonValue>,
    #[serde(default)]
    state: JsonMap<String, JsonValue>,
    #[serde(default)]
    nodes: Vec<JsonValue>,
    #[serde(default)]
    edges: Vec<JsonValue>,
    #[serde(default)]
    tombstones: Vec<JsonValue>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistDeltaPayload {
    #[serde(default)]
    before_snapshot: PersistSnapshot,
    #[serde(default)]
    after_snapshot: PersistSnapshot,
    #[serde(default)]
    now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistDeltaResult {
    upsert_nodes: Vec<JsonValue>,
    upsert_edges: Vec<JsonValue>,
    delete_node_ids: Vec<String>,
    delete_edge_ids: Vec<String>,
    tombstones: Vec<JsonValue>,
    runtime_meta_patch: JsonMap<String, JsonValue>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistCompactRecordSet {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    serialized: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistCompactHashRecordSet {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    hashes: Vec<u32>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistCompactTombstoneSet {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    serialized: Vec<String>,
    #[serde(default)]
    target_keys: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistCompactHashTombstoneSet {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    hashes: Vec<u32>,
    #[serde(default)]
    target_keys: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistDeltaCompactPayload {
    #[serde(default)]
    before_nodes: PersistCompactRecordSet,
    #[serde(default)]
    after_nodes: PersistCompactRecordSet,
    #[serde(default)]
    before_edges: PersistCompactRecordSet,
    #[serde(default)]
    after_edges: PersistCompactRecordSet,
    #[serde(default)]
    before_tombstones: PersistCompactRecordSet,
    #[serde(default)]
    after_tombstones: PersistCompactTombstoneSet,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistDeltaCompactHashPayload {
    #[serde(default)]
    before_nodes: PersistCompactHashRecordSet,
    #[serde(default)]
    after_nodes: PersistCompactHashRecordSet,
    #[serde(default)]
    before_edges: PersistCompactHashRecordSet,
    #[serde(default)]
    after_edges: PersistCompactHashRecordSet,
    #[serde(default)]
    before_tombstones: PersistCompactHashRecordSet,
    #[serde(default)]
    after_tombstones: PersistCompactHashTombstoneSet,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistDeltaIdResult {
    upsert_node_ids: Vec<String>,
    upsert_edge_ids: Vec<String>,
    delete_node_ids: Vec<String>,
    delete_edge_ids: Vec<String>,
    upsert_tombstone_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HydrateRecordsPayload {
    #[serde(default)]
    nodes: Vec<JsonValue>,
    #[serde(default)]
    edges: Vec<JsonValue>,
    #[serde(default)]
    records_normalized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HydrateRecordsDiagnostics {
    solver: String,
    node_count: usize,
    edge_count: usize,
    records_normalized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HydrateRecordsResult {
    ok: bool,
    used_native: bool,
    nodes: Vec<JsonValue>,
    edges: Vec<JsonValue>,
    diagnostics: HydrateRecordsDiagnostics,
}

fn default_iterations() -> u32 {
    80
}

fn default_repulsion() -> f64 {
    2800.0
}

fn default_spring_k() -> f64 {
    0.048
}

fn default_damping() -> f64 {
    0.88
}

fn default_center_gravity() -> f64 {
    0.014
}

fn default_min_gap() -> f64 {
    12.0
}

fn default_speed_cap() -> f64 {
    3.8
}

fn default_strength() -> f64 {
    0.5
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

fn clamp_node_to_region(x: &mut f64, y: &mut f64, radius: f64, rect: &RegionRect) {
    let safe_radius = radius.max(1.0) + 6.0;
    let min_x = rect.x + safe_radius;
    let max_x = rect.x + rect.w - safe_radius;
    let min_y = rect.y + safe_radius;
    let max_y = rect.y + rect.h - safe_radius;
    *x = clamp(*x, min_x, max_x);
    *y = clamp(*y, min_y, max_y);
}

fn normalize_json_record_id(value: Option<&JsonValue>) -> String {
    value
        .and_then(JsonValue::as_str)
        .map(|item| item.trim().to_string())
        .unwrap_or_default()
}

fn normalize_json_number_i64(value: Option<&JsonValue>, fallback: i64) -> i64 {
    match value {
        Some(JsonValue::Number(number)) => number.as_f64().unwrap_or(fallback as f64).floor() as i64,
        Some(JsonValue::String(text)) => text.parse::<f64>().ok().map(|item| item.floor() as i64).unwrap_or(fallback),
        _ => fallback,
    }
}

fn sanitize_json_records(records: Vec<JsonValue>) -> Vec<JsonValue> {
    records
        .into_iter()
        .filter(|record| record.is_object())
        .filter(|record| normalize_json_record_id(record.get("id")).is_empty() == false)
        .collect()
}

fn clone_hydrate_records(records: Vec<JsonValue>) -> Vec<JsonValue> {
    records
        .into_iter()
        .filter(|record| record.is_object())
        .collect()
}

fn sanitize_persist_snapshot(snapshot: PersistSnapshot) -> PersistSnapshot {
    PersistSnapshot {
        meta: snapshot.meta,
        state: snapshot.state,
        nodes: sanitize_json_records(snapshot.nodes),
        edges: sanitize_json_records(snapshot.edges),
        tombstones: sanitize_json_records(snapshot.tombstones),
    }
}

fn build_json_serialized_index(records: &[JsonValue]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for record in records {
        let id = normalize_json_record_id(record.get("id"));
        if id.is_empty() {
            continue;
        }
        let serialized = serde_json::to_string(record).unwrap_or_else(|_| "null".to_string());
        map.insert(id, serialized);
    }
    map
}

fn build_compact_hash_lookup<'a>(ids: &'a [String], hashes: &'a [u32]) -> HashMap<&'a str, u32> {
    let mut map = HashMap::new();
    let len = ids.len().min(hashes.len());
    for index in 0..len {
        let id = ids[index].trim();
        if id.is_empty() {
            continue;
        }
        map.insert(id, hashes[index]);
    }
    map
}

fn build_json_value_index(records: &[JsonValue]) -> HashMap<String, JsonValue> {
    let mut map = HashMap::new();
    for record in records {
        let id = normalize_json_record_id(record.get("id"));
        if id.is_empty() {
            continue;
        }
        map.insert(id, record.clone());
    }
    map
}

fn build_runtime_meta_patch(snapshot: &PersistSnapshot) -> JsonMap<String, JsonValue> {
    const RESERVED_KEYS: [&str; 8] = [
        "revision",
        "lastModified",
        "nodeCount",
        "edgeCount",
        "tombstoneCount",
        "syncDirty",
        "syncDirtyReason",
        "lastMutationReason",
    ];

    let mut patch = JsonMap::new();
    for (key, value) in &snapshot.meta {
        if RESERVED_KEYS.contains(&key.as_str()) {
            continue;
        }
        patch.insert(key.clone(), value.clone());
    }

    patch.insert(
        "lastProcessedFloor".to_string(),
        JsonValue::from(normalize_json_number_i64(
            snapshot.state.get("lastProcessedFloor"),
            -1,
        )),
    );
    patch.insert(
        "extractionCount".to_string(),
        JsonValue::from(normalize_json_number_i64(
            snapshot.state.get("extractionCount"),
            0,
        )),
    );
    patch.insert("schemaVersion".to_string(), JsonValue::from(1));
    patch.insert(
        "chatId".to_string(),
        JsonValue::from(normalize_json_record_id(snapshot.meta.get("chatId"))),
    );
    patch
}

fn ensure_delete_tombstone(
    tombstone_map: &mut HashMap<String, JsonValue>,
    kind: &str,
    target_id: &str,
    deleted_at: i64,
    source_device_id: &str,
) {
    let normalized_kind = kind.trim();
    let normalized_target_id = target_id.trim();
    if normalized_kind.is_empty() || normalized_target_id.is_empty() {
        return;
    }

    let key = format!("{}:{}", normalized_kind, normalized_target_id);
    if tombstone_map.contains_key(&key) {
        return;
    }

    let mut record = JsonMap::new();
    record.insert("id".to_string(), JsonValue::from(key.clone()));
    record.insert("kind".to_string(), JsonValue::from(normalized_kind));
    record.insert("targetId".to_string(), JsonValue::from(normalized_target_id));
    record.insert("deletedAt".to_string(), JsonValue::from(deleted_at));
    record.insert(
        "sourceDeviceId".to_string(),
        JsonValue::from(source_device_id.trim().to_string()),
    );
    tombstone_map.insert(key, JsonValue::Object(record));
}

fn solve_persist_delta_in_rust(payload: PersistDeltaPayload) -> PersistDeltaResult {
    let before_snapshot = sanitize_persist_snapshot(payload.before_snapshot);
    let after_snapshot = sanitize_persist_snapshot(payload.after_snapshot);
    let now_ms = payload.now_ms.unwrap_or(0.0).floor() as i64;
    let deleted_at = if now_ms > 0 { now_ms } else { 0 };

    let before_node_json_by_id = build_json_serialized_index(&before_snapshot.nodes);
    let after_node_json_by_id = build_json_serialized_index(&after_snapshot.nodes);
    let before_edge_json_by_id = build_json_serialized_index(&before_snapshot.edges);
    let after_edge_json_by_id = build_json_serialized_index(&after_snapshot.edges);
    let before_tombstone_json_by_id = build_json_serialized_index(&before_snapshot.tombstones);
    let after_node_by_id = build_json_value_index(&after_snapshot.nodes);
    let after_edge_by_id = build_json_value_index(&after_snapshot.edges);
    let after_tombstone_by_id = build_json_value_index(&after_snapshot.tombstones);

    let mut upsert_nodes = Vec::new();
    for (id, record) in &after_node_by_id {
        if before_node_json_by_id.get(id)
            != Some(&serde_json::to_string(record).unwrap_or_else(|_| "null".to_string()))
        {
            upsert_nodes.push(record.clone());
        }
    }

    let mut upsert_edges = Vec::new();
    for (id, record) in &after_edge_by_id {
        if before_edge_json_by_id.get(id)
            != Some(&serde_json::to_string(record).unwrap_or_else(|_| "null".to_string()))
        {
            upsert_edges.push(record.clone());
        }
    }

    let mut delete_node_ids = Vec::new();
    for id in before_node_json_by_id.keys() {
        if !after_node_json_by_id.contains_key(id) {
            delete_node_ids.push(id.clone());
        }
    }

    let mut delete_edge_ids = Vec::new();
    for id in before_edge_json_by_id.keys() {
        if !after_edge_json_by_id.contains_key(id) {
            delete_edge_ids.push(id.clone());
        }
    }

    let mut tombstone_map = HashMap::new();
    for (id, record) in &after_tombstone_by_id {
        if before_tombstone_json_by_id.get(id)
            != Some(&serde_json::to_string(record).unwrap_or_else(|_| "null".to_string()))
        {
            let kind = normalize_json_record_id(record.get("kind"));
            let target_id = normalize_json_record_id(record.get("targetId"));
            if kind.is_empty() || target_id.is_empty() {
                continue;
            }
            tombstone_map.insert(format!("{}:{}", kind, target_id), record.clone());
        }
    }

    let source_device_id = normalize_json_record_id(
        after_snapshot
            .meta
            .get("deviceId")
            .or_else(|| before_snapshot.meta.get("deviceId")),
    );

    for node_id in &delete_node_ids {
        ensure_delete_tombstone(
            &mut tombstone_map,
            "node",
            node_id,
            deleted_at,
            &source_device_id,
        );
    }
    for edge_id in &delete_edge_ids {
        ensure_delete_tombstone(
            &mut tombstone_map,
            "edge",
            edge_id,
            deleted_at,
            &source_device_id,
        );
    }

    PersistDeltaResult {
        upsert_nodes,
        upsert_edges,
        delete_node_ids,
        delete_edge_ids,
        tombstones: tombstone_map.into_values().collect(),
        runtime_meta_patch: build_runtime_meta_patch(&after_snapshot),
    }
}

fn build_compact_serialized_lookup<'a>(
    ids: &'a [String],
    serialized: &'a [String],
) -> HashMap<&'a str, &'a str> {
    let mut map = HashMap::new();
    let len = ids.len().min(serialized.len());
    for index in 0..len {
        let id = ids[index].trim();
        if id.is_empty() {
            continue;
        }
        map.insert(id, serialized[index].as_str());
    }
    map
}

fn build_compact_target_key_lookup<'a>(
    ids: &'a [String],
    target_keys: &'a [String],
) -> HashMap<&'a str, &'a str> {
    let mut map = HashMap::new();
    let len = ids.len().min(target_keys.len());
    for index in 0..len {
        let id = ids[index].trim();
        if id.is_empty() {
            continue;
        }
        map.insert(id, target_keys[index].trim());
    }
    map
}

fn solve_persist_delta_compact_in_rust(payload: PersistDeltaCompactPayload) -> PersistDeltaIdResult {
    let before_node_json_by_id =
        build_compact_serialized_lookup(&payload.before_nodes.ids, &payload.before_nodes.serialized);
    let after_node_json_by_id =
        build_compact_serialized_lookup(&payload.after_nodes.ids, &payload.after_nodes.serialized);
    let before_edge_json_by_id =
        build_compact_serialized_lookup(&payload.before_edges.ids, &payload.before_edges.serialized);
    let after_edge_json_by_id =
        build_compact_serialized_lookup(&payload.after_edges.ids, &payload.after_edges.serialized);
    let before_tombstone_json_by_id = build_compact_serialized_lookup(
        &payload.before_tombstones.ids,
        &payload.before_tombstones.serialized,
    );
    let after_tombstone_target_key_by_id = build_compact_target_key_lookup(
        &payload.after_tombstones.ids,
        &payload.after_tombstones.target_keys,
    );

    let mut upsert_node_ids = Vec::new();
    let after_node_len = payload
        .after_nodes
        .ids
        .len()
        .min(payload.after_nodes.serialized.len());
    for index in 0..after_node_len {
        let id = payload.after_nodes.ids[index].trim();
        if id.is_empty() {
            continue;
        }
        let serialized = payload.after_nodes.serialized[index].as_str();
        if before_node_json_by_id.get(id) != Some(&serialized) {
            upsert_node_ids.push(id.to_string());
        }
    }

    let mut upsert_edge_ids = Vec::new();
    let after_edge_len = payload
        .after_edges
        .ids
        .len()
        .min(payload.after_edges.serialized.len());
    for index in 0..after_edge_len {
        let id = payload.after_edges.ids[index].trim();
        if id.is_empty() {
            continue;
        }
        let serialized = payload.after_edges.serialized[index].as_str();
        if before_edge_json_by_id.get(id) != Some(&serialized) {
            upsert_edge_ids.push(id.to_string());
        }
    }

    let mut delete_node_ids = Vec::new();
    for id in &payload.before_nodes.ids {
        let normalized_id = id.trim();
        if normalized_id.is_empty() {
            continue;
        }
        if !after_node_json_by_id.contains_key(normalized_id) {
            delete_node_ids.push(normalized_id.to_string());
        }
    }

    let mut delete_edge_ids = Vec::new();
    for id in &payload.before_edges.ids {
        let normalized_id = id.trim();
        if normalized_id.is_empty() {
            continue;
        }
        if !after_edge_json_by_id.contains_key(normalized_id) {
            delete_edge_ids.push(normalized_id.to_string());
        }
    }

    let mut upsert_tombstone_ids = Vec::new();
    let after_tombstone_len = payload
        .after_tombstones
        .ids
        .len()
        .min(payload.after_tombstones.serialized.len());
    for index in 0..after_tombstone_len {
        let id = payload.after_tombstones.ids[index].trim();
        if id.is_empty() {
            continue;
        }
        let target_key = after_tombstone_target_key_by_id
            .get(id)
            .copied()
            .unwrap_or_default();
        if target_key.is_empty() {
            continue;
        }
        let serialized = payload.after_tombstones.serialized[index].as_str();
        if before_tombstone_json_by_id.get(id) != Some(&serialized) {
            upsert_tombstone_ids.push(id.to_string());
        }
    }

    PersistDeltaIdResult {
        upsert_node_ids,
        upsert_edge_ids,
        delete_node_ids,
        delete_edge_ids,
        upsert_tombstone_ids,
    }
}

fn solve_persist_delta_compact_hash_in_rust(
    payload: PersistDeltaCompactHashPayload,
) -> PersistDeltaIdResult {
    let before_node_hash_by_id =
        build_compact_hash_lookup(&payload.before_nodes.ids, &payload.before_nodes.hashes);
    let after_node_hash_by_id =
        build_compact_hash_lookup(&payload.after_nodes.ids, &payload.after_nodes.hashes);
    let before_edge_hash_by_id =
        build_compact_hash_lookup(&payload.before_edges.ids, &payload.before_edges.hashes);
    let after_edge_hash_by_id =
        build_compact_hash_lookup(&payload.after_edges.ids, &payload.after_edges.hashes);
    let before_tombstone_hash_by_id = build_compact_hash_lookup(
        &payload.before_tombstones.ids,
        &payload.before_tombstones.hashes,
    );
    let after_tombstone_target_key_by_id = build_compact_target_key_lookup(
        &payload.after_tombstones.ids,
        &payload.after_tombstones.target_keys,
    );

    let mut upsert_node_ids = Vec::new();
    let after_node_len = payload
        .after_nodes
        .ids
        .len()
        .min(payload.after_nodes.hashes.len());
    for index in 0..after_node_len {
        let id = payload.after_nodes.ids[index].trim();
        if id.is_empty() {
            continue;
        }
        let hash = payload.after_nodes.hashes[index];
        if before_node_hash_by_id.get(id) != Some(&hash) {
            upsert_node_ids.push(id.to_string());
        }
    }

    let mut upsert_edge_ids = Vec::new();
    let after_edge_len = payload
        .after_edges
        .ids
        .len()
        .min(payload.after_edges.hashes.len());
    for index in 0..after_edge_len {
        let id = payload.after_edges.ids[index].trim();
        if id.is_empty() {
            continue;
        }
        let hash = payload.after_edges.hashes[index];
        if before_edge_hash_by_id.get(id) != Some(&hash) {
            upsert_edge_ids.push(id.to_string());
        }
    }

    let mut delete_node_ids = Vec::new();
    for id in &payload.before_nodes.ids {
        let normalized_id = id.trim();
        if normalized_id.is_empty() {
            continue;
        }
        if !after_node_hash_by_id.contains_key(normalized_id) {
            delete_node_ids.push(normalized_id.to_string());
        }
    }

    let mut delete_edge_ids = Vec::new();
    for id in &payload.before_edges.ids {
        let normalized_id = id.trim();
        if normalized_id.is_empty() {
            continue;
        }
        if !after_edge_hash_by_id.contains_key(normalized_id) {
            delete_edge_ids.push(normalized_id.to_string());
        }
    }

    let mut upsert_tombstone_ids = Vec::new();
    let after_tombstone_len = payload
        .after_tombstones
        .ids
        .len()
        .min(payload.after_tombstones.hashes.len());
    for index in 0..after_tombstone_len {
        let id = payload.after_tombstones.ids[index].trim();
        if id.is_empty() {
            continue;
        }
        let target_key = after_tombstone_target_key_by_id
            .get(id)
            .copied()
            .unwrap_or_default();
        if target_key.is_empty() {
            continue;
        }
        let hash = payload.after_tombstones.hashes[index];
        if before_tombstone_hash_by_id.get(id) != Some(&hash) {
            upsert_tombstone_ids.push(id.to_string());
        }
    }

    PersistDeltaIdResult {
        upsert_node_ids,
        upsert_edge_ids,
        delete_node_ids,
        delete_edge_ids,
        upsert_tombstone_ids,
    }
}

fn build_region_buckets(nodes: &[LayoutNode]) -> HashMap<String, Vec<usize>> {
    let mut region_buckets = HashMap::new();
    for (index, node) in nodes.iter().enumerate() {
        region_buckets
            .entry(node.region_key.clone())
            .or_insert_with(Vec::new)
            .push(index);
    }
    region_buckets
}

fn build_region_spring_ideals(nodes: &[LayoutNode]) -> HashMap<String, f64> {
    let mut count_by_region: HashMap<String, usize> = HashMap::new();
    let mut area_by_region: HashMap<String, f64> = HashMap::new();

    for node in nodes {
        *count_by_region.entry(node.region_key.clone()).or_insert(0) += 1;
        area_by_region
            .entry(node.region_key.clone())
            .or_insert_with(|| {
                let area = node.region_rect.w.max(1.0) * node.region_rect.h.max(1.0);
                area.max(1.0)
            });
    }

    let mut result = HashMap::new();
    for (region_key, count) in count_by_region {
        let area = *area_by_region.get(&region_key).unwrap_or(&1.0);
        let count_f64 = (count.max(1)) as f64;
        let ideal = (0.78 * (area / count_f64).sqrt()).clamp(36.0, 92.0);
        result.insert(region_key, ideal);
    }
    result
}

fn build_in_region_edges(nodes: &[LayoutNode], edges: &[LayoutEdge]) -> Vec<(usize, usize, f64)> {
    let mut result = Vec::new();
    for edge in edges {
        if edge.from >= nodes.len() || edge.to >= nodes.len() || edge.from == edge.to {
            continue;
        }
        if nodes[edge.from].region_key != nodes[edge.to].region_key {
            continue;
        }
        result.push((edge.from, edge.to, edge.strength));
    }
    result
}

fn solve_layout_in_rust(payload: LayoutPayload) -> LayoutResult {
    let config = payload.config.unwrap_or(LayoutConfig {
        iterations: default_iterations(),
        repulsion: default_repulsion(),
        spring_k: default_spring_k(),
        damping: default_damping(),
        center_gravity: default_center_gravity(),
        min_gap: default_min_gap(),
        speed_cap: default_speed_cap(),
    });

    let mut nodes = payload.nodes;
    let edge_count = payload.edges.len();

    if nodes.is_empty() {
        return LayoutResult {
            ok: true,
            used_native: true,
            positions: Vec::new(),
            diagnostics: LayoutDiagnostics {
                solver: "rust-wasm".to_string(),
                node_count: 0,
                edge_count,
                iterations: 0,
            },
        };
    }

    let iterations = clamp(config.iterations as f64, 8.0, 220.0) as u32;
    let repulsion = clamp(config.repulsion, 100.0, 120_000.0);
    let spring_k = clamp(config.spring_k, 0.001, 1.0);
    let damping = clamp(config.damping, 0.1, 0.999);
    let center_gravity = clamp(config.center_gravity, 0.0001, 1.0);
    let min_gap = clamp(config.min_gap, 0.0, 120.0);
    let speed_cap = clamp(config.speed_cap, 0.5, 20.0);

    for node in &mut nodes {
        node.radius = node.radius.max(1.0);
    }

    let region_buckets = build_region_buckets(&nodes);
    let spring_ideal_by_region = build_region_spring_ideals(&nodes);
    let in_region_edges = build_in_region_edges(&nodes, &payload.edges);

    let mut center_x = vec![0.0_f64; nodes.len()];
    let mut center_y = vec![0.0_f64; nodes.len()];
    for (index, node) in nodes.iter().enumerate() {
        center_x[index] = node.region_rect.x + node.region_rect.w / 2.0;
        center_y[index] = node.region_rect.y + node.region_rect.h / 2.0;
    }

    let mut fx = vec![0.0_f64; nodes.len()];
    let mut fy = vec![0.0_f64; nodes.len()];
    let mut actual_iterations = 0_u32;
    let mut stable_rounds = 0_u32;

    for _ in 0..iterations {
        actual_iterations += 1;
        fx.fill(0.0);
        fy.fill(0.0);

        for bucket in region_buckets.values() {
            for left in 0..bucket.len() {
                let i = bucket[left];
                for right in (left + 1)..bucket.len() {
                    let j = bucket[right];

                    let dx = nodes[j].x - nodes[i].x;
                    let dy = nodes[j].y - nodes[i].y;
                    let mut dist_sq = dx * dx + dy * dy;
                    if dist_sq < 0.25 {
                        dist_sq = 0.25;
                    }
                    let dist = dist_sq.sqrt();
                    let min_sep = nodes[i].radius + nodes[j].radius + min_gap;
                    let mut force = repulsion / dist_sq;
                    if dist < min_sep {
                        force += (min_sep - dist) * 0.22;
                    }
                    let inv_dist = if dist > 0.0 { 1.0 / dist } else { 0.0 };
                    let force_x = dx * inv_dist * force;
                    let force_y = dy * inv_dist * force;

                    fx[i] -= force_x;
                    fy[i] -= force_y;
                    fx[j] += force_x;
                    fy[j] += force_y;
                }
            }
        }

        for (from, to, strength) in &in_region_edges {
            let from_index = *from;
            let to_index = *to;
            let strength_value = *strength;

            let dx = nodes[to_index].x - nodes[from_index].x;
            let dy = nodes[to_index].y - nodes[from_index].y;
            let dist = (dx * dx + dy * dy).sqrt().max(0.001);
            let ideal = *spring_ideal_by_region
                .get(&nodes[from_index].region_key)
                .unwrap_or(&68.0);
            let displacement = dist - ideal * (0.82 + 0.18 * strength_value);
            let force = spring_k * displacement * (0.45 + 0.55 * strength_value);
            let force_x = (dx / dist) * force;
            let force_y = (dy / dist) * force;

            fx[from_index] += force_x;
            fy[from_index] += force_y;
            fx[to_index] -= force_x;
            fy[to_index] -= force_y;
        }

        let mut max_speed = 0.0_f64;
        for (index, node) in nodes.iter_mut().enumerate() {
            fx[index] += (center_x[index] - node.x) * center_gravity;
            fy[index] += (center_y[index] - node.y) * center_gravity;

            if node.pinned {
                continue;
            }

            node.vx = (node.vx + fx[index]) * damping;
            node.vy = (node.vy + fy[index]) * damping;
            let speed = (node.vx * node.vx + node.vy * node.vy).sqrt();
            if speed > max_speed {
                max_speed = speed;
            }
            if speed > speed_cap {
                let scale = speed_cap / speed;
                node.vx *= scale;
                node.vy *= scale;
            }
            node.x += node.vx;
            node.y += node.vy;
            clamp_node_to_region(&mut node.x, &mut node.y, node.radius, &node.region_rect);
        }

        if max_speed < 0.015 {
            stable_rounds += 1;
            if stable_rounds >= 6 {
                break;
            }
        } else {
            stable_rounds = 0;
        }
    }

    let node_count = nodes.len();
    let mut positions = Vec::with_capacity(nodes.len() * 2);
    for node in nodes {
        positions.push(node.x as f32);
        positions.push(node.y as f32);
    }

    LayoutResult {
        ok: true,
        used_native: true,
        positions,
        diagnostics: LayoutDiagnostics {
            solver: "rust-wasm".to_string(),
            node_count,
            edge_count,
            iterations: actual_iterations,
        },
    }
}

#[wasm_bindgen]
pub fn solve_layout(payload: JsValue) -> Result<JsValue, JsValue> {
    let parsed: LayoutPayload = serde_wasm_bindgen::from_value(payload)
        .map_err(|error| JsValue::from_str(&format!("invalid payload: {error}")))?;
    let solved = solve_layout_in_rust(parsed);
    serde_wasm_bindgen::to_value(&solved)
        .map_err(|error| JsValue::from_str(&format!("serialize result failed: {error}")))
}

#[wasm_bindgen]
pub fn build_persist_delta(payload: JsValue) -> Result<JsValue, JsValue> {
    let parsed: PersistDeltaPayload = serde_wasm_bindgen::from_value(payload)
        .map_err(|error| JsValue::from_str(&format!("invalid persist payload: {error}")))?;
    let solved = solve_persist_delta_in_rust(parsed);
    serde_wasm_bindgen::to_value(&solved)
        .map_err(|error| JsValue::from_str(&format!("serialize persist result failed: {error}")))
}

#[wasm_bindgen]
pub fn build_persist_delta_compact(payload: JsValue) -> Result<JsValue, JsValue> {
    let parsed: PersistDeltaCompactPayload = serde_wasm_bindgen::from_value(payload)
        .map_err(|error| JsValue::from_str(&format!("invalid compact persist payload: {error}")))?;
    let solved = solve_persist_delta_compact_in_rust(parsed);
    serde_wasm_bindgen::to_value(&solved).map_err(|error| {
        JsValue::from_str(&format!("serialize compact persist result failed: {error}"))
    })
}

#[wasm_bindgen]
pub fn build_persist_delta_compact_hash(payload: JsValue) -> Result<JsValue, JsValue> {
    let parsed: PersistDeltaCompactHashPayload = serde_wasm_bindgen::from_value(payload)
        .map_err(|error| JsValue::from_str(&format!("invalid hash compact persist payload: {error}")))?;
    let solved = solve_persist_delta_compact_hash_in_rust(parsed);
    serde_wasm_bindgen::to_value(&solved).map_err(|error| {
        JsValue::from_str(&format!("serialize hash compact persist result failed: {error}"))
    })
}

#[wasm_bindgen]
pub fn build_hydrate_records(payload: JsValue) -> Result<JsValue, JsValue> {
    let parsed: HydrateRecordsPayload = serde_wasm_bindgen::from_value(payload)
        .map_err(|error| JsValue::from_str(&format!("invalid hydrate payload: {error}")))?;
    let solved = solve_hydrate_records_in_rust(parsed);
    serde_wasm_bindgen::to_value(&solved)
        .map_err(|error| JsValue::from_str(&format!("serialize hydrate result failed: {error}")))
}
