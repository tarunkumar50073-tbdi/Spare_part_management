import React from "react";
import { Link, useLocation } from "react-router-dom";
import { Compass } from "lucide-react";

// An unknown address used to render an empty page inside the layout, which
// reads as "the app is broken". Say what happened and offer a way back.
export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="max-w-md mx-auto mt-16 text-center">
      <div className="card p-8">
        <Compass className="mx-auto mb-4 text-slate-400" size={40} aria-hidden="true" />
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Page not found</h2>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Nothing lives at <span className="font-mono text-slate-700 dark:text-slate-200">{pathname}</span>.
          It may have moved, or the link is mistyped.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Link to="/" className="btn-primary">Dashboard</Link>
          <Link to="/services" className="btn-secondary">All Services</Link>
        </div>
      </div>
    </div>
  );
}
