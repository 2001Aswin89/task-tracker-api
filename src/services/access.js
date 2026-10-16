const { query } = require('../db/pool');
const { notFound, forbidden } = require('../errors');

/** Returns the caller's role in a team ('owner' | 'member'), or null if not a member. */
async function teamRole(teamId, userId) {
  const { rows } = await query('SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
  return rows[0]?.role ?? null;
}

/** Throws 404 if the team does not exist, 403 if the caller is not a member. Returns the role. */
async function requireTeamMember(teamId, userId) {
  const exists = await query('SELECT 1 FROM teams WHERE id = $1', [teamId]);
  if (!exists.rowCount) throw notFound('Team');
  const role = await teamRole(teamId, userId);
  if (!role) throw forbidden('You are not a member of this team');
  return role;
}

/**
 * Load a task the caller may see: they created it, are assigned to it, or belong to its team.
 * Anything else is reported as 404 so task ids cannot be probed.
 * Adds is_team_owner so callers can decide on destructive operations.
 */
async function getAccessibleTask(taskId, userId) {
  const { rows } = await query(
    `SELECT t.*, COALESCE(tm.role = 'owner', false) AS is_team_owner
       FROM tasks t
       LEFT JOIN team_members tm ON tm.team_id = t.team_id AND tm.user_id = $2
      WHERE t.id = $1
        AND (t.created_by = $2 OR t.assignee_id = $2 OR tm.user_id IS NOT NULL)`,
    [taskId, userId]
  );
  if (!rows.length) throw notFound('Task');
  return rows[0];
}

module.exports = { teamRole, requireTeamMember, getAccessibleTask };
