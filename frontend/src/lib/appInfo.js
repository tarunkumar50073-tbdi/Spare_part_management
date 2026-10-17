// What the app calls itself and where to get help — one place, read by the
// sign-in card, the sidebar's foot and the Support / Help dialog.
export const APP_NAME = "TBDI Digital SMP";
// Shown beside the signed-in role at the foot of the menu ("Admin · v1.0").
export const APP_VERSION = "1.0";
export const APP_OWNER = "Toyota Boshoku DX";

// Support contacts. Update these to the store's real support address / number.
export const SUPPORT = {
  email: "tarun.kumar@toyota-boshoku.com",
  phone: "+91 99922 07800",
  team: "TBDI Digital SMP / DX Support — Toyota Boshoku",
  hours: "Mon–Sat 09:00–17:00",
  plants: [
    { label: "Plant 1", url: "https://www.google.com/maps/search/?api=1&query=Toyota+Boshoku+Device+India+Plant+1" },
    { label: "Plant 2", url: "https://www.google.com/maps/search/?api=1&query=Toyota+Boshoku+Device+India+Plant+2" },
  ],
};

// The signed-in role as people say it.
export const roleLabel = (user) => (user?.is_admin ? "Admin" : user?.role === "STORE_USER" ? "Store User" : user?.role || "User");
