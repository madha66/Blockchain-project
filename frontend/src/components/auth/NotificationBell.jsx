import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HiBell } from 'react-icons/hi';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../utils/api';

/** Header bell with the unread count, polled every 20 seconds while logged in. */
const NotificationBell = () => {
  const { isLoggedIn } = useAuth();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!isLoggedIn) return undefined;
    const load = () => api('/notifications').then((d) => setUnread(d.unread)).catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [isLoggedIn]);

  if (!isLoggedIn) return null;
  return (
    <Link to="/app/notifications" className="notif-bell" aria-label={`Notifications, ${unread} unread`}>
      <HiBell size={20} />
      {unread > 0 && <span className="notif-count">{unread > 9 ? '9+' : unread}</span>}
    </Link>
  );
};

export default NotificationBell;
