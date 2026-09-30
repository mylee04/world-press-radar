SELECT day,tool,traffic,calls,successes,errors,
 ROUND(100.0*errors/NULLIF(calls,0),2) AS error_percent,
 ROUND(1.0*duration_sum_ms/NULLIF(calls,0),1) AS average_ms,
 duration_max_ms AS maximum_ms,
 latency_le_100,latency_101_500,latency_501_2000,latency_gt_2000
FROM daily_tool_usage ORDER BY day DESC,tool,traffic;
