import React, { useState, useEffect } from 'react';
import { store } from '../store';

interface LoginScreenProps {
  onSuccess: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onSuccess }) => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [pwStrength, setPwStrength] = useState(0);
  const [pwLabel, setPwLabel] = useState('Very weak');
  const [pwColor, setPwColor] = useState('#ef5f63');


  // Calculate password strength
  useEffect(() => {
    if (!password) {
      setPwStrength(0);
      setPwLabel('Very weak');
      setPwColor('#ef5f63');
      return;
    }

    let score = 0;
    if (password.length >= 8) score += 20;
    if (/[a-z]/.test(password)) score += 20;
    if (/[A-Z]/.test(password)) score += 20;
    if (/\d/.test(password)) score += 20;
    if (/[^A-Za-z0-9]/.test(password)) score += 20;

    setPwStrength(score);

    if (score <= 20) {
      setPwLabel('Very weak');
      setPwColor('#ef5f63');
    } else if (score <= 40) {
      setPwLabel('Weak');
      setPwColor('#f59e0b');
    } else if (score <= 60) {
      setPwLabel('Fair');
      setPwColor('#3b82f6');
    } else if (score <= 80) {
      setPwLabel('Good');
      setPwColor('#10b981');
    } else {
      setPwLabel('Strong');
      setPwColor('#065f46');
    }
  }, [password]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!username.trim() || !password) {
      setErrorMsg('All fields are required.');
      return;
    }

    // The store hashes the password; pass the raw value exactly once.
    const res = isSignUp ? store.signup(username, password) : store.login(username, password);
    if (!res.success) {
      setErrorMsg(res.msg);
      return;
    }
    if (isSignUp) {
      // New accounts are always UNCLASSIFIED; sign in straight away.
      const signedIn = store.login(username, password);
      if (!signedIn.success) {
        setErrorMsg(signedIn.msg);
        return;
      }
    }
    onSuccess();
  };

  return (
    <div className="login-window">
      <div className="login-container">
        {/* Left Side: Hero Panel */}
        <div className="login-hero">
          <div>
            <div className="login-logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="64" height="64">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <h1 className="hero-title">Aegis Nexus</h1>
            <span className="hero-subtitle">Intelligence Analysis Platform</span>
            
            <div className="hero-features">
              <div className="features-title">Advanced Intelligence Features:</div>
              <ul className="features-list">
                <li>Case-isolated virtual containers</li>
                <li>Directed entity relationship graphs</li>
                <li>Interactive geospatial mapping</li>
                <li>Multi-dimensional chronological narratives</li>
                <li>Private local AI review & analysis</li>
              </ul>
            </div>
          </div>

          <div className="hero-version">
            v2.0.0
          </div>
        </div>

        {/* Right Side: Form Panel */}
        <div className="login-panel">
          <div className="panel-content">
            <h2 className="panel-title">
              {isSignUp ? 'Create Account' : 'Sign In'}
            </h2>
            <p className="panel-subtitle">
              {isSignUp ? 'Register to start analyzing intelligence data' : 'Welcome back to your intelligence workspace'}
            </p>
            
            <form onSubmit={handleSubmit} className="login-form">
              {/* Mode Select */}
              <div className="form-group">
                <label className="form-label">Mode</label>
                <select
                  className="form-select"
                  value={isSignUp ? 'signup' : 'signin'}
                  onChange={(e) => {
                    setIsSignUp(e.target.value === 'signup');
                    setErrorMsg('');
                  }}
                >
                  <option value="signin">Sign In</option>
                  <option value="signup">Sign Up / Register</option>
                </select>
              </div>

              {/* Username */}
              <div className="form-group">
                <label className="form-label">Username</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Enter analyst name..."
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </div>

              {/* Password */}
              <div className="form-group">
                <label className="form-label">Password</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder="Enter credentials..."
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>

              {/* Password Strength Meter (Only for Sign Up) */}
              {isSignUp && password && (
                <div className="form-group strength-container">
                  <div className="strength-header">
                    <span className="strength-label">Strength: {pwLabel}</span>
                  </div>
                  <div className="strength-bar-bg">
                    <div
                      className="strength-bar-fill"
                      style={{
                        width: `${pwStrength}%`,
                        backgroundColor: pwColor
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Clearance is assigned by a TOP_SECRET administrator, never self-selected */}
              {isSignUp && (
                <p className="footer-text">
                  New accounts start at Unclassified. An administrator must raise clearance.
                </p>
              )}

              {/* Error Message */}
              {errorMsg && (
                <div className="error-message">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {errorMsg}
                </div>
              )}

              {/* Submit Button */}
              <button className="btn btn-primary btn-lg" type="submit">
                {isSignUp ? 'Create Account' : 'Sign In'}
              </button>
            </form>

            <div className="panel-footer">
              <p className="footer-text">
                Default credentials: admin / admin
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
