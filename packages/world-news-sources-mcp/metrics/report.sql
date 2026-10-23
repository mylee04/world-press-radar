SELECT day,tool,traffic,calls,successes,errors,
 ROUND(100.0*errors/NULLIF(calls,0),2) AS error_percent,
 ROUND(1.0*duration_sum_ms/NULLIF(calls,0),1) AS average_ms,
 duration_max_ms AS maximum_ms,
 latency_le_100,latency_101_500,latency_501_2000,latency_gt_2000
FROM (SELECT * FROM daily_tool_usage UNION ALL SELECT * FROM daily_activity_tool_usage UNION ALL SELECT * FROM daily_extended_tool_usage) ORDER BY day DESC,tool,traffic;

-- These are observed calls, never a count of people. Inspection is a client-supplied hint.
-- A known empty pagination page has matches and stays separate from a zero-match search.
SELECT day,traffic,channel,events,
 search_nonempty + search_zero_matches + search_empty_page AS known_successful_searches,
 search_zero_matches,search_empty_page,search_unknown,
 ROUND(100.0*search_zero_matches/NULLIF(search_nonempty+search_zero_matches+search_empty_page,0),2) AS zero_match_percent,
 export_nonempty + export_empty + export_unknown AS successful_exports,
 export_nonempty,export_empty,export_unknown,
 identity_provided,identity_missing,identity_excluded,identity_suppressed,identity_disabled
FROM daily_product_usage WHERE day >= date('now','-6 days') ORDER BY day DESC,traffic,channel;

-- A returning key was present on a different day within the preceding seven UTC days.
-- No same-day repeat is a return; missing IDs, opt-outs and other clients are not reconstructed.
-- Returning counts include observed retained presence only. A zero does not establish no return before activation or outside the retained window.
SELECT a.day,COUNT(*) AS observed_keys,
 SUM(EXISTS(SELECT 1 FROM usage_actor_days b WHERE b.actor_key=a.actor_key
   AND b.day BETWEEN date(a.day,'-7 days') AND date(a.day,'-1 day'))) AS returning_keys_prior_7_days
FROM usage_actor_days a WHERE a.day >= date('now','-6 days') GROUP BY a.day ORDER BY a.day DESC;
