# AutoLander

AutoLander is a desktop app for auto dealership sales teams. It automates Facebook Marketplace posting, manages buyer conversations with AI-assisted replies, tracks leads through a pipeline, and syncs inventory from multiple feed sources — all in one place.

## Download & Install

Go to the **[Latest Release](https://github.com/mgarbs/autolander/releases/latest)** and download the installer for your system:

| System | File | Notes |
|--------|------|-------|
| **Windows** | `AutoLander Setup 1.0.0.exe` | Run the installer and follow the prompts |
| **Mac (Apple Silicon)** | `AutoLander-1.0.0-arm64.dmg` | M1/M2/M3 Macs — open the .dmg and drag to Applications |
| **Mac (Intel)** | `AutoLander-1.0.0.dmg` | Older Intel Macs |
| **Linux** | `AutoLander-1.0.0.AppImage` | Make executable with `chmod +x`, then double-click |

> **First launch note:** The app will download a browser component (~300 MB) on first startup. This only happens once and requires an internet connection.

## Getting Started

### 1. Create Your Dealership Account

1. Open AutoLander
2. Click **Register**
3. Enter your dealership name, your name, email, and password
4. This creates your dealership organization — you are the **Admin**

### 2. Add Your Sales Team

As an Admin:

1. Go to **Settings**
2. Under team management, add salespeople by name, email, and role
3. Each salesperson logs in on their own computer with the credentials you set up

### Roles

- **Admin** — Full access. Manages team, inventory feeds, and settings.
- **Manager** — Read-only dashboard. Can view all activity and leads in real time.
- **Salesperson** — Posts vehicles, manages conversations, handles leads.

### 3. Connect Facebook

1. Go to the **Facebook** page in the app
2. Click **Log In to Facebook**
3. You'll see a browser window — log in with your Facebook credentials
4. The app saves your session so you don't have to log in every time

### 4. Set Up Inventory Feeds (Admin)

1. Go to **Settings > Inventory Feeds**
2. Add your feed URL (supports CarGurus, Cars.com, AutoTrader, or generic XML/JSON)
3. Vehicles sync automatically on a schedule, or click **Sync Now**

### 5. Post Vehicles to Facebook

1. Go to **Vehicles**
2. Select a vehicle from your inventory
3. Click **Post to Facebook** — the AI generates a listing for you to review
4. Approve and post

### 6. Manage Leads & Conversations

- The **Conversations** page shows all buyer messages from Facebook
- AI suggests replies that you can edit before sending
- Leads are scored automatically so you know who's most interested
- When a conversation needs personal attention, it gets flagged for handoff

### 7. Book Appointments (Optional)

If your admin connects Google Calendar in Settings:

- Schedule test drives and appointments directly from a conversation
- Buyers get email confirmations and SMS reminders automatically

## Features

- **Facebook Marketplace Automation** — Post vehicles and monitor your inbox
- **AI-Powered Replies** — Claude generates contextual responses to buyer messages
- **Inventory Sync** — Pull vehicles from CarGurus, Cars.com, AutoTrader, or custom feeds
- **Lead Scoring** — Automatically ranks buyer interest level
- **Real-Time Dashboard** — Live activity feed and team performance stats
- **Appointment Booking** — Google Calendar integration with email/SMS notifications
- **Offline Support** — Queue messages while offline, they send when you reconnect
- **Auto-Updates** — The app updates itself in the background

## Troubleshooting

**"Chrome is downloading" on first launch**
This is normal. The app needs a browser for Facebook automation. Wait for it to finish (~1-2 minutes depending on your connection).

**Can't log in to Facebook**
Make sure you're using the correct Facebook credentials. If Facebook asks for a verification code, enter it in the browser window that appears.

**App won't start on Mac**
If macOS blocks the app, go to **System Preferences > Security & Privacy** and click **Open Anyway**.

**App won't start on Linux**
Make sure the AppImage is executable: `chmod +x AutoLander-1.0.0.AppImage`

**Connection errors**
Check your internet connection. The app needs to reach the cloud server to sync data and use AI features.

## Support

Having issues? Contact your dealership admin or reach out at [GitHub Issues](https://github.com/mgarbs/autolander/issues).
