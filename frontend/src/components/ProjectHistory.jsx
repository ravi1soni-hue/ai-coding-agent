import React from 'react';

export default function ProjectHistory({
  projectId,
  projectHistory,
  historyLoading,
  redeployingProjectId,
  redeployStatus,
  redeployError,
  onClose,
  onSelectProject,
  onRedeployProject,
}) {
  return (
    <div className="historyOverlay" role="dialog" aria-modal="true">
      <div className="historyPanel">
        <div className="historyHeader">
          <h3>Project History</h3>
          <button className="topActionBtn ghost" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="historyBody">
          {historyLoading ? <div className="historyEmpty">Loading history...</div> : null}
          {!historyLoading && projectHistory.length === 0 ? (
            <div className="historyEmpty">No previous projects yet.</div>
          ) : null}

          {projectHistory.map((p) => (
            <div
              key={p.id}
              className={`historyItem ${p.id === projectId ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectProject(p.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectProject(p.id);
              }}
            >
              <div className="historyItemTop">
                <span className="historyId">{p.id}</span>
                <span className="historyStatus">{p.status}</span>
              </div>
              <div className="historyMeta">
                {Math.round((Number(p.progress) || 0) * 100)}% | {p.current_step || 'init'}
              </div>
              {p.frontend_url || p.backend_url ? (
                <div className="historyMeta">
                  {p.frontend_url ? `Vercel: ${p.frontend_url}` : ''}
                  {p.frontend_url && p.backend_url ? ' | ' : ''}
                  {p.backend_url ? `Railway: ${p.backend_url}` : ''}
                </div>
              ) : null}
              <div className="historyActions">
                <button
                  className="topActionBtn"
                  type="button"
                  disabled={redeployingProjectId === p.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRedeployProject(p.id);
                  }}
                >
                  {redeployingProjectId === p.id ? 'Redeploying…' : 'Redeploy'}
                </button>
              </div>
            </div>
          ))}

          {redeployStatus ? <div className="historyNotice success">{redeployStatus}</div> : null}
          {redeployError ? <div className="historyNotice error">{redeployError}</div> : null}
        </div>
      </div>
    </div>
  );
}
