import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HiChevronDown, HiUserCircle } from 'react-icons/hi';
import { useAuth } from '../../context/AuthContext';
import './auth.css';

/**
 * "Sign up / Log in" when logged out; a profile dropdown when logged in.
 */
const ProfileMenu = ({ compact = false }) => {
  const { user, isLoggedIn, scope, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (!isLoggedIn) {
    return (
      <div className="auth-row">
        <Link className="btn btn-ghost btn-sm" to="/login">Log in</Link>
        <Link className="btn btn-outline btn-sm" to="/signup">{scope === 'signup' ? 'Resume sign-up' : 'Sign up'}</Link>
      </div>
    );
  }

  const doLogout = async () => {
    setOpen(false);
    await logout();
    navigate('/');
  };

  return (
    <div className="profile-menu" ref={ref}>
      <button className="profile-menu-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <HiUserCircle size={20} className="text-gold" />
        {!compact && <span>{user?.name?.split(' ')[0]}</span>}
        <HiChevronDown size={14} />
      </button>
      {open && (
        <div className="profile-menu-list" role="menu">
          <Link role="menuitem" to="/app/profile" onClick={() => setOpen(false)}>Profile</Link>
          <Link role="menuitem" to="/app/notifications" onClick={() => setOpen(false)}>Notifications</Link>
          <Link role="menuitem" to="/app/loans" onClick={() => setOpen(false)}>My loans</Link>
          {user?.isAdmin && <Link role="menuitem" to="/app/admin" onClick={() => setOpen(false)}>Admin</Link>}
          <button role="menuitem" onClick={doLogout}>Log out</button>
        </div>
      )}
    </div>
  );
};

export default ProfileMenu;
