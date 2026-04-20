import { useState } from "react";

type Props = {
  title: string;
  message: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
};

export function PasswordPrompt({ title, message, onSubmit, onCancel }: Props): JSX.Element {
  const [pwd, setPwd] = useState("");
  return (
    <div className="modal-bg">
      <div className="modal">
        <h3>{title}</h3>
        <p style={{ color: "var(--text-dim)", margin: "0 0 14px" }}>{message}</p>
        <input
          type="password"
          autoFocus
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit(pwd)}
          placeholder="Wallet password"
        />
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn secondary" onClick={onCancel}>Cancel</button>
          <button className="btn" onClick={() => onSubmit(pwd)}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
