use base64::Engine;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::HashSet;

pub const SCHEMA: &str = "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,profile_id TEXT); CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,content TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attachment_refs(id TEXT PRIMARY KEY);";

fn attachment_id(attachment: &Value) -> Result<String, String> {
    let id = attachment
        .get("id")
        .and_then(Value::as_str)
        .ok_or("附件缺少 id")?;
    if id.is_empty()
        || id.len() > 256
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
    {
        return Err("附件 id 无效".into());
    }
    Ok(id.into())
}
pub fn get(database: &Connection, key: &str) -> Result<Value, String> {
    let json: Result<String, _> =
        database.query_row("SELECT value FROM kv WHERE key=?1", [key], |row| row.get(0));
    let mut value: Value = match json {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string())?,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(Value::Null),
        Err(e) => return Err(e.to_string()),
    };
    if key == "conversations" {
        let conversations = value.as_array_mut().ok_or("已保存会话格式无效")?;
        for conversation in conversations {
            if let Some(messages) = conversation
                .get_mut("messages")
                .and_then(Value::as_array_mut)
            {
                for message in messages {
                    if let Some(attachments) =
                        message.get_mut("attachments").and_then(Value::as_array_mut)
                    {
                        for attachment in attachments {
                            if attachment.get("content").is_none() {
                                let id = attachment_id(attachment)?;
                                let content: String = database
                                    .query_row(
                                        "SELECT content FROM attachments WHERE id=?1",
                                        [&id],
                                        |row| row.get(0),
                                    )
                                    .map_err(|e| format!("附件 {id} 恢复失败: {e}"))?;
                                attachment
                                    .as_object_mut()
                                    .ok_or("附件格式无效")?
                                    .insert("content".into(), Value::String(content));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(value)
}
pub fn set(database: &mut Connection, key: &str, mut value: Value) -> Result<(), String> {
    if key.is_empty() || key.len() > 256 {
        return Err("存储键长度必须为 1–256".into());
    }
    let transaction = database.transaction().map_err(|e| e.to_string())?;
    if key == "conversations" {
        transaction
            .execute("DELETE FROM attachment_refs", [])
            .map_err(|e| e.to_string())?;
        let conversations = value.as_array_mut().ok_or("conversations 必须是数组")?;
        let mut ids = HashSet::new();
        for conversation in conversations {
            if let Some(messages) = conversation
                .get_mut("messages")
                .and_then(Value::as_array_mut)
            {
                for message in messages {
                    if let Some(attachments) =
                        message.get_mut("attachments").and_then(Value::as_array_mut)
                    {
                        for attachment in attachments {
                            let id = attachment_id(attachment)?;
                            let kind = attachment
                                .get("type")
                                .and_then(Value::as_str)
                                .ok_or("附件缺少 type")?
                                .to_owned();
                            let content = match attachment
                                .as_object_mut()
                                .ok_or("附件格式无效")?
                                .remove("content")
                            {
                                Some(Value::String(content)) => content,
                                _ => return Err("附件缺少 content".into()),
                            };
                            if kind == "image" {
                                if content.len() > 27_000_000 {
                                    return Err("图片附件超过 20 MB".into());
                                }
                                let (header, data) =
                                    content.split_once(',').ok_or("图片附件必须是 data URL")?;
                                if !header.starts_with("data:image/")
                                    || !header.ends_with(";base64")
                                    || header.len() > 256
                                {
                                    return Err("图片 data URL 格式无效".into());
                                }
                                let bytes = base64::engine::general_purpose::STANDARD
                                    .decode(data)
                                    .map_err(|e| format!("附件 base64 无效: {e}"))?;
                                if bytes.len() > 20_000_000 {
                                    return Err("图片附件超过 20 MB".into());
                                }
                            } else if kind == "text" {
                                if content.len() > 20_000_000 {
                                    return Err("文本附件超过 20 MB".into());
                                }
                            } else {
                                return Err("仅支持 image/text 附件".into());
                            }
                            if !ids.insert(id.clone()) {
                                let existing: String = transaction
                                    .query_row(
                                        "SELECT content FROM attachments WHERE id=?1",
                                        [&id],
                                        |row| row.get(0),
                                    )
                                    .map_err(|e| e.to_string())?;
                                if existing != content {
                                    return Err("同一附件 id 对应了不同内容".into());
                                }
                            }
                            transaction.execute("INSERT INTO attachments(id,content) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET content=excluded.content",params![id,content]).map_err(|e|e.to_string())?;
                            transaction
                                .execute(
                                    "INSERT OR IGNORE INTO attachment_refs(id) VALUES(?1)",
                                    [&id],
                                )
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
        transaction
            .execute(
                "DELETE FROM attachments WHERE id NOT IN (SELECT id FROM attachment_refs)",
                [],
            )
            .map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    if json.len() > 32 * 1024 * 1024 {
        return Err("单项 JSON（附件内容已独立存储）不能超过 32 MB".into());
    }
    transaction.execute("INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,json]).map_err(|e|e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachments_are_independent_and_garbage_collected() {
        let mut database = Connection::open_in_memory().unwrap();
        database.execute_batch(SCHEMA).unwrap();
        let value = serde_json::json!([{"id":"c","messages":[{"attachments":[{"id":"a","type":"text","content":"attachment content"}]}]}]);
        set(&mut database, "conversations", value.clone()).unwrap();
        let json: String = database
            .query_row("SELECT value FROM kv WHERE key='conversations'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(!json.contains("attachment content"));
        assert_eq!(get(&database, "conversations").unwrap(), value);
        set(&mut database, "conversations", serde_json::json!([])).unwrap();
        assert_eq!(
            database
                .query_row("SELECT COUNT(*) FROM attachments", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn failed_attachment_save_keeps_previous_conversations_and_blobs() {
        let mut database = Connection::open_in_memory().unwrap();
        database.execute_batch(SCHEMA).unwrap();
        let valid = serde_json::json!([{"messages":[{"attachments":[{"id":"a","type":"text","content":"original"}]}]}]);
        set(&mut database, "conversations", valid.clone()).unwrap();
        let invalid = serde_json::json!([{"messages":[{"attachments":[{"id":"bad/id","type":"text","content":"new"}]}]}]);
        assert!(set(&mut database, "conversations", invalid).is_err());
        assert_eq!(get(&database, "conversations").unwrap(), valid);
    }
    #[test]
    fn multiple_large_images_do_not_hit_json_kv_limit() {
        let mut database = Connection::open_in_memory().unwrap();
        database.execute_batch(SCHEMA).unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(vec![7u8; 13_000_000]);
        let content = format!("data:image/png;base64,{encoded}");
        let value = serde_json::json!([{"messages":[{"attachments":[{"id":"large-a","type":"image","content":content},{"id":"large-b","type":"image","content":content}]}]}]);
        assert!(serde_json::to_string(&value).unwrap().len() > 32 * 1024 * 1024);
        set(&mut database, "conversations", value).unwrap();
        let json_len: i64 = database
            .query_row(
                "SELECT length(value) FROM kv WHERE key='conversations'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(json_len < 1000);
        let restored = get(&database, "conversations").unwrap();
        assert_eq!(
            restored[0]["messages"][0]["attachments"][0]["content"]
                .as_str()
                .unwrap(),
            content
        );
        assert_eq!(
            restored[0]["messages"][0]["attachments"][1]["content"]
                .as_str()
                .unwrap(),
            content
        );
    }
}
