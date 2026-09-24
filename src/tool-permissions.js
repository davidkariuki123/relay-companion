// Read-only catalog entries shared by MCP annotations and Claude Code's
// bounded allow rules. Keep writes out of this set, even if they feel routine.
export const READ_ONLY_RELAY_TOOL_NAMES = new Set([
  "relay_ai_sessions",
  "relay_contacts_search",
  "relay_groups_list",
  "relay_session_updates",
  "relay_inbox_list",
  "relay_share_stats",
  "relay_sent_list",
  "relay_thread_fetch",
  "relay_chats_list",
  "relay_chat_fetch",
  "relay_recently_deleted_list",
  "relay_file_download",
  "relay_topics_list",
  "relay_topic_fetch",
  "relay_topic_context",
  "relay_topic_threads",
  "relay_connector_list_tools",
]);
