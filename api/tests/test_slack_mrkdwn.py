"""Exhaustive Markdown-to-Slack-mrkdwn conversion tests."""

from services.slack_mrkdwn import markdown_to_slack_mrkdwn


def test_headings_h1_through_h6_become_bold_lines():
    for hashes in ("#", "##", "###", "####", "#####", "######"):
        assert markdown_to_slack_mrkdwn(f"{hashes} Title") == "*Title*"


def test_bold_and_italic_are_normalized_including_nested_emphasis():
    text = "_italic_, *also italic*, **bold**, __also bold__, and **bold _inside_**"
    assert markdown_to_slack_mrkdwn(text) == (
        "_italic_, _also italic_, *bold*, *also bold*, and *bold _inside_*"
    )


def test_snake_case_and_spaced_multiplication_survive():
    text = "some_thing_here and 3 * 4 * 5 stay literal"
    assert markdown_to_slack_mrkdwn(text) == text


def test_markdown_links_convert_in_sentences_and_bullets():
    text = "Visit [billing](https://x.io/b).\n- Open [schedule](https://x.io/s)"
    assert markdown_to_slack_mrkdwn(text) == (
        "Visit <https://x.io/b|billing>.\n• Open <https://x.io/s|schedule>"
    )


def test_all_bullet_markers_normalize_and_indentation_survives():
    text = "- one\n* two\n+ three\n  - nested"
    assert markdown_to_slack_mrkdwn(text) == "• one\n• two\n• three\n  • nested"


def test_horizontal_rules_are_dropped():
    assert markdown_to_slack_mrkdwn("before\n---\n***\n___\nafter") == (
        "before\nafter"
    )


def test_two_column_table_becomes_key_value_lines():
    text = "| Stage | Deals |\n|-|-|\n| Lead | 40 |\n| Won | 12 |"
    assert markdown_to_slack_mrkdwn(text) == "*Lead:* 40\n*Won:* 12"


def test_three_column_table_becomes_aligned_protected_code_block():
    text = (
        "| Stage | Deals | Value |\n"
        "|-|-|-|\n"
        "| Lead | 40 | **$10k** |\n"
        "| Won | 12 | $50k |"
    )
    assert markdown_to_slack_mrkdwn(text) == (
        "```\n"
        "Stage | Deals | Value   \n"
        "------+-------+---------\n"
        "Lead  | 40    | **$10k**\n"
        "Won   | 12    | $50k    \n"
        "```"
    )


def test_code_fences_inline_code_and_tables_in_code_are_untouched():
    text = (
        "Run `**literal**` then:\n"
        "```\n## not a heading\n| a | b |\n|-|-|\n| **1** | 2 |\n```"
    )
    assert markdown_to_slack_mrkdwn(text) == text


def test_protector_instances_do_not_collide_in_mixed_content():
    text = (
        "## Snapshot\n\n"
        "**131 active**\n\n"
        "| Stage | Deals | Value |\n|-|-|-|\n| Lead | 40 | $120k |"
    )
    result = markdown_to_slack_mrkdwn(text)
    assert "*Snapshot*" in result
    assert "*131 active*" in result
    assert "```\nStage" in result
    assert result.count("131 active") == 1


def test_plain_empty_and_unmatched_markup_pass_through():
    assert markdown_to_slack_mrkdwn("") == ""
    text = "Plain text with an unmatched * marker."
    assert markdown_to_slack_mrkdwn(text) == text


def test_entity_span_markup_reduces_to_display_text():
    text = (
        "Declined <span data-entity='{\"context_type\":\"submission\","
        "\"id\":\"da550000-0000-0000-0000-000000000017\","
        "\"display\":\"SESS-117 — Blockchain Meets LLMs\"}'>"
        "SESS-117 — Blockchain Meets LLMs</span> with a note."
    )
    result = markdown_to_slack_mrkdwn(text)
    assert result == "Declined SESS-117 — Blockchain Meets LLMs with a note."
    assert "<span" not in result and "data-entity" not in result


def test_bare_entity_json_token_reduces_to_display_text():
    text = (
        'I accepted {"context_type":"submission",'
        '"id":"da550000-0000-0000-0000-000000000001",'
        '"display":"SESS-101 — Agents in Prod"} this morning.'
    )
    result = markdown_to_slack_mrkdwn(text)
    assert result == "I accepted SESS-101 — Agents in Prod this morning."
