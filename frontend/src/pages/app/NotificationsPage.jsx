import React, { useCallback, useEffect, useState } from 'react';
import { HiBell, HiCheck } from 'react-icons/hi';
import { api, describeError } from '../../utils/api';
import './Admin.css';

/**
 * In-app inbox. Every notice is signed by the member's named community contact and names
 * the grievance officer. Notices created outside 08:00–19:00 wait for the next window.
 */
const NotificationsPage = () => {
  const [data, setData] = useState({ items: [], unread: 0, queued: 0 });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api('/notifications'));
      setError('');
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const markRead = async (id) => {
    await api(`/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
    load();
  };

  const markAll = async () => {
    await api('/notifications/read-all', { method: 'POST' }).catch(() => {});
    load();
  };

  return (
    <div className="adm-page">
      <div className="adm-header">
        <div>
          <h1 className="adm-title"><HiBell /> Notifications</h1>
          <p className="text-secondary">
            Messages about your loans. We only contact you between 08:00 and 19:00, and never anyone else on your behalf.
          </p>
        </div>
        {data.unread > 0 && (
          <button className="btn btn-outline btn-sm" onClick={markAll}><HiCheck /> Mark all read</button>
        )}
      </div>
      {error && <div className="auth-error">{error}</div>}
      {data.queued > 0 && (
        <p className="text-secondary">{data.queued} message{data.queued > 1 ? 's' : ''} will arrive in the next contact window.</p>
      )}
      {data.items.length === 0 && !error && <div className="dark-card">No messages yet.</div>}
      <div className="adm-list">
        {data.items.map((n) => (
          <article key={n.id} className={`dark-card adm-notice ${n.readAt ? '' : 'adm-unread'}`} onClick={() => !n.readAt && markRead(n.id)}>
            <header>
              <strong>{n.title}</strong>
              <span className="text-secondary">{new Date(n.sentAt).toLocaleString()}</span>
            </header>
            <p className="adm-notice-body">{n.body}</p>
            <footer className="text-secondary">From {n.contactName}</footer>
          </article>
        ))}
      </div>
    </div>
  );
};

export default NotificationsPage;
