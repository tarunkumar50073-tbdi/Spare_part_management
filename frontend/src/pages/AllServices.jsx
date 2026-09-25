import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Heart, ArrowRight } from "lucide-react";
import Glyph from "../components/Glyph.jsx";
import { assistantService } from "../services/assistantService.js";

const CATEGORY_ORDER = ["Overview", "Inventory", "Masters", "Receiving", "Reports", "System"];
const FAV_KEY = "dx_fav_services";

const loadFavs = () => {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); }
  catch { return new Set(); }
};

// Every screen in one place — a searchable, categorised launcher.
export default function AllServices() {
  const [services, setServices] = useState([]);
  const [tab, setTab] = useState("All");
  const [query, setQuery] = useState("");
  const [favs, setFavs] = useState(loadFavs);

  useEffect(() => {
    assistantService.services().then((r) => setServices(r.data.data || [])).catch(() => setServices([]));
  }, []);

  const toggleFav = (key) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(FAV_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const categories = useMemo(() => {
    const present = new Set(services.map((s) => s.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [services]);

  const counts = useMemo(() => {
    const by = { All: services.length, Favorites: services.filter((s) => favs.has(s.key)).length };
    services.forEach((s) => { by[s.category] = (by[s.category] || 0) + 1; });
    return by;
  }, [services, favs]);

  const visible = useMemo(() => {
    const kw = query.trim().toLowerCase();
    return services.filter((s) => {
      if (tab === "Favorites" ? !favs.has(s.key) : tab !== "All" && s.category !== tab) return false;
      if (!kw) return true;
      const hay = (s.title + " " + s.category + " " + (s.keywords || []).join(" ")).toLowerCase();
      return hay.includes(kw);
    });
  }, [services, tab, query, favs]);

  const tabs = ["All", "Favorites", ...categories];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-800 dark:text-white">All Services</h2>
          <p className="text-sm text-slate-400">Every screen you can open, in one place · {services.length} services</p>
        </div>
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a service…"
            className="w-full rounded-full border border-slate-200 bg-white pl-9 pr-4 py-2 text-sm focus:outline-none
              focus:ring-2 focus:ring-toyotared/40 focus:border-toyotared dark:border-navy-700 dark:bg-navy-900"
          />
        </div>
      </div>

      {/* category tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-navy-800 pb-2">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              tab === t
                ? "bg-toyotared text-white"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-navy-800"}`}
          >
            {t} <span className="opacity-70">· {counts[t] || 0}</span>
          </button>
        ))}
      </div>

      {/* cards */}
      {visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">
          {tab === "Favorites"
            ? "No favourites yet — tap the heart on a service to pin it here."
            : services.length === 0
              ? "Couldn’t load services — please refresh the page."
              : "No service matches your search."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((s) => (
            <div key={s.key}
              className="group relative flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm
                hover:border-toyotared/40 hover:shadow-md transition dark:border-navy-800 dark:bg-navy-900">
              <button
                onClick={() => toggleFav(s.key)}
                aria-label={favs.has(s.key) ? "Unpin" : "Pin to favourites"}
                className="absolute right-3 top-3 text-slate-300 hover:text-toyotared"
              >
                <Heart size={16} className={favs.has(s.key) ? "fill-toyotared text-toyotared" : ""} />
              </button>

              <div className="grid h-14 w-14 place-items-center rounded-full bg-slate-100 text-2xl text-slate-600 dark:bg-navy-800 dark:text-slate-300">
                {/* The catalogue names its icons as emoji; Glyph draws the line icon. */}
                <Glyph icon={s.icon} size={26} strokeWidth={1.75} />
              </div>
              <h3 className="mt-3 text-base font-bold text-slate-800 dark:text-white">{s.title}</h3>
              <span className="mt-1 inline-block w-fit rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-navy-800 dark:text-slate-400">
                {s.category}
              </span>

              <Link
                to={s.route}
                className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-toyotared hover:gap-2 transition-all"
              >
                Open <ArrowRight size={15} />
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
