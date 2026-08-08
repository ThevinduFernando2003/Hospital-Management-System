# ClinicPro — Hospital / Clinic Management System

Multi-branch clinic management system built as a **Semester 3 DBMS project**. ClinicPro covers patient registration, doctor scheduling, appointments, treatments, invoicing, payments, and insurance claims — with role-based portals for Admin, Receptionist, Doctor, and Branch Manager.

**Live stack:** Frontend on [Firebase Hosting](https://firebase.google.com/) · API & MySQL on [Railway](https://railway.app/)

---

## Features

| Area | What it does |
|------|----------------|
| **Multi-branch clinics** | Manage branches, staff, and branch-scoped operations (sample: MedSync Colombo, Kandy, Galle) |
| **Role-based access** | JWT-secured portals for Admin, Receptionist, Doctor, Branch Manager |
| **Appointments** | Book, reschedule (audited), cancel; emergency flag; 30-minute slot integrity |
| **Doctor availability** | Weekly schedules → free-slot generation for booking |
| **Clinical visits** | Doctors complete appointments with notes and treatments |
| **Billing & insurance** | Treatment-based invoices, partial payments, insurance coverage & claims |
| **Analytics** | SQL reporting views + Chart.js dashboards (revenue, outstanding, treatments, insurance) |

---

## Tech stack

| Layer | Technologies |
|-------|----------------|
| **Database** | MySQL — 17 tables, 10 triggers, 1 stored procedure, 5 views |
| **Backend** | Node.js, Express 5, mysql2, JWT, bcryptjs |
| **Frontend** | HTML, CSS, JavaScript, Bootstrap 5, Chart.js |
| **Deploy** | Firebase Hosting (frontend), Railway (API + MySQL) |

---

## Project structure

```
Hospital-Management-System/
├── database.sql          # Full schema, triggers, procedure, views, seed data
├── run-sql.js            # Script to load database.sql into MySQL
├── backend/
│   ├── server.js         # Express REST API
│   └── package.json
├── frontend/
│   ├── index.html        # Login
│   ├── admin.html        # Admin dashboard
│   ├── reception.html    # Reception desk
│   ├── doctor-portal.html
│   ├── branch.html       # Branch manager dashboard
│   └── *.js / style.css
├── firebase.json         # Firebase Hosting config
└── package.json          # Root helpers (dotenv, mysql2 for run-sql.js)
```

---

## Database highlights

### Schema (17 tables)

`Role`, `Account_Info`, `Branch`, `Staff`, `Specialties`, `Doctor`, `doctor_specialties`, `doctor_availability`, `Insurance_Provider`, `Patient`, `Appointment`, `rescheduled_appointments`, `Treatment_Catalogue`, `Appointment_Treatment`, `Invoice`, `Payment`, `Insurance_Claim`

### Triggers (examples)

- Prevent overlapping appointments (30-minute window) on insert/update
- Block doctor deletion when future appointments exist
- Update invoice status after payment; prevent overpayment
- Validate patient date of birth
- Protect deletion of treatments, specialties, and insurers still in use

### Stored procedure

`CalculateInvoiceFromTreatments` — sums treatment prices (default consultation fee if none), applies insurance coverage, creates the invoice and optional initial payment.

### Reporting views

| View | Purpose |
|------|---------|
| `vw_branch_appointment_summary` | Branch/day appointment counts by status |
| `vw_doctor_revenue` | Revenue per doctor / specialty |
| `vw_patients_outstanding` | Patients with due balances |
| `vw_treatment_statistics` | Treatment volume & revenue by month |
| `vw_insurance_analysis` | Coverage analysis by provider |

---

## Role portals

| Role | Portal | Capabilities |
|------|--------|----------------|
| **Admin** | `admin.html` | System stats, reports, patients, staff, branches, insurance, treatments, specialties |
| **Receptionist** | `reception.html` | Patients, appointments, schedules, invoices & payments (branch-scoped) |
| **Doctor** | `doctor-portal.html` | Appointments, complete visits, patient history, weekly availability |
| **Branch Manager** | `branch.html` | Branch dashboard, appointments, staff, invoices, branch reports |

Patient REST APIs are implemented on the backend; a dedicated patient UI is not included in `frontend/`.

---

## Getting started

### Prerequisites

- Node.js 18+
- MySQL 8+
- (Optional) Firebase CLI for frontend hosting

### 1. Clone and install

```bash
git clone https://github.com/ThevinduFernando2003/Hospital-Management-System.git
cd Hospital-Management-System

npm install
cd backend && npm install && cd ..
```

### 2. Configure the database

Create a MySQL database, then either:

**Option A — load the full script**

```bash
mysql -u <user> -p <database.sql
```

**Option B — use the helper script**

Create a root `.env` with MySQL credentials, then:

```bash
node run-sql.js
```

### 3. Configure the backend

Create `backend/.env`:

```env
PORT=3000
JWT_SECRET=your_strong_secret_here
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=your_database
MYSQL_PORT=3306
```

### 4. Run the API

```bash
cd backend
npm start
```

Server defaults to `http://localhost:3000`.

### 5. Run the frontend

Serve the `frontend/` folder (any static server), or open pages via a local server so API calls work with CORS:

```bash
npx serve frontend
```

Point the frontend API base URL at your local backend if it currently targets the production Railway URL.

---

## API overview

| Group | Examples |
|-------|----------|
| **Auth** | `POST /api/login`, `POST /api/login/patient`, `PUT /api/profile/change-password` |
| **Lists** | `GET /api/list/:type` (`patients`, `doctors`, `branches`, …) |
| **Admin** | Stats, CRUD for branches/staff/insurance/treatments/specialties, reports |
| **Reception** | Patients, appointments, reschedule, availability slots, invoices, payments |
| **Doctor** | Profile, appointments, complete visit, patient history, availability |
| **Branch manager** | Branch-scoped stats, staff, invoices, reports |
| **Patient** | Doctors, my appointments, my documents, book appointment |

Protected routes expect `Authorization: Bearer <token>`.

---

## Deployment

| Component | Platform |
|-----------|----------|
| Frontend | Firebase Hosting (`public: frontend`) |
| Backend API | Railway |
| MySQL | Railway |

Set the same `JWT_SECRET` and `MYSQL_*` variables in the Railway environment as in local `.env`. Do not commit secrets — `.env` is gitignored.

---

## Course context

Semester 3 **Database Management Systems** project demonstrating:

- Relational design and normalization for a real clinic domain
- Business rules enforced with **triggers** and a **stored procedure**
- Analytical **views** wired into application reports
- Full-stack integration of MySQL with a REST API and role-based UI

---

## License

This project is for academic / educational use. Forked from [Lekshan-Rajapaksha/HMS](https://github.com/Lekshan-Rajapaksha/HMS).
