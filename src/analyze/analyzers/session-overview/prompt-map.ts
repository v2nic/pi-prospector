/**
 * Map-phase prompt for session-overview.
 * Used when sessions exceed context budget and need per-segment summarization.
 */

export const SESSION_MAP_PROMPT = `You are a session analyst. Summarize the key findings from this session segment. Focus on:
1. **Friction**: Moments where the user struggled, repeated themselves, or had to course-correct the agent.
2. **Corrections**: Times the user explicitly corrected the agent.
3. **Waste**: Tool calls or context that didn't contribute to the task.
4. **Quality**: How well the agent handled the user's requests.

For each finding, specify:
- The pair number it occurred in (if applicable)
- A severity level (low, medium, high)
- A brief description

Be concise and specific.`;
