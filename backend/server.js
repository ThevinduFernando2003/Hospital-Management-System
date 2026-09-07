// server.js
require('dotenv').config();

const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { generateAvailableSlots } = require('./lib/slots');
const { createRateLimiter } = require('./lib/rateLimit');
const { buildCorsOptions } = require('./lib/corsOptions');

const app = express();
const PORT = process.env.PORT || 3000;
const host = '0.0.0.0'; // Listen on all network interfaces
const APP_STARTED_AT = new Date().toISOString();

// --- SECRET KEY (IMPORTANT!) ---
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV !== 'test') {
    console.error('FATAL ERROR: JWT_SECRET environment variable is not set.');
    process.exit(1);
}

// --- DATABASE CONFIGURATION ---
const dbConfig = {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    port: process.env.MYSQL_PORT, // <-- Don't forget the port
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
};

const pool = mysql.createPool(dbConfig);
const loginRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 20),
    message: 'Too many login attempts. Please try again in 15 minutes.',
});

// --- MIDDLEWARE ---
app.use(cors(buildCorsOptions()));
app.use(express.json());

// --- HEALTH / READINESS ---
app.get('/api/health', async (req, res) => {
    const payload = {
        status: 'ok',
        service: 'clinicpro-api',
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: APP_STARTED_AT,
        timestamp: new Date().toISOString(),
    };

    try {
        await pool.query('SELECT 1 AS ok');
        payload.database = 'up';
        return res.json(payload);
    } catch (err) {
        payload.status = 'degraded';
        payload.database = 'down';
        payload.message = 'API is up but database is unreachable.';
        return res.status(503).json(payload);
    }
});

// --- UTILITY FUNCTION for error handling ---
const handleDatabaseError = (res, err) => {
    console.error("Database Error:", err);
    res.status(500).json({ message: err.message || "An internal server error occurred." });
};

// --- AUTHENTICATION & AUTHORIZATION ---

// Authorization Middleware
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Authentication token required.' });
        }
        const token = authHeader.split(' ')[1];
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = decoded; // { userId, role }

            const userRoleLower = req.user.role.toLowerCase();
            const allowedRolesLower = allowedRoles.map(r => r.toLowerCase());

            if (allowedRolesLower.includes(userRoleLower)) {
                next();
            } else {
                res.status(403).json({ message: 'Forbidden: You do not have permission for this resource.' });
            }
        } catch (err) {
            res.status(401).json({ message: 'Invalid or expired token.' });
        }
    };
};

// Login Endpoint (rate-limited)
app.post("/api/login", loginRateLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }
    try {
        const [rows] = await pool.query(`
            SELECT ai.user_id, ai.username, ai.password_hash, r.name as role
            FROM Account_Info ai
            JOIN Role r ON ai.role_id = r.role_id
            WHERE ai.username = ?
        `, [username]);

        if (rows.length === 0) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        const token = jwt.sign(
            { userId: user.user_id, role: user.role.toLowerCase() },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({ message: "Login successful", token, role: user.role.toLowerCase() });

    } catch (err) {
        handleDatabaseError(res, err);
    }
});

// --- GENERIC LISTS (for populating dropdowns) ---
app.get("/api/list/:type", authorize(['admin', 'receptionist', 'doctor', 'branch manager']), async (req, res) => {
    const { type } = req.params;
    let query;
    let params = [];
    try {
        // Get branch_id for receptionist filtering
        let receptionistBranchId = null;
        if (req.user.role === 'receptionist') {
            const [[staff]] = await pool.query('SELECT branch_id FROM Staff WHERE user_id = ?', [req.user.userId]);
            if (!staff || !staff.branch_id) {
                return res.status(403).json({ message: 'Receptionist not assigned to any branch.' });
            }
            receptionistBranchId = staff.branch_id;
        }

        switch (type) {
            case "patients": query = "SELECT patient_id, name FROM Patient ORDER BY name"; break;
            case "doctors":
                query = `
                    SELECT d.doctor_id, s.name, GROUP_CONCAT(DISTINCT sp.name SEPARATOR ', ') as specialty
                    FROM Doctor d
                    LEFT JOIN Staff s ON d.staff_id = s.staff_id
                    LEFT JOIN doctor_specialties ds ON d.doctor_id = ds.doctor_id
                    LEFT JOIN Specialties sp ON ds.specialty_id = sp.specialty_id`;
                if (receptionistBranchId) {
                    query += ` WHERE s.branch_id = ?`;
                    params.push(receptionistBranchId);
                }
                query += `
                    GROUP BY d.doctor_id, s.name
                    ORDER BY s.name`;
                break;
            case "branches":
                if (receptionistBranchId) {
                    // Receptionist can only see their own branch
                    query = "SELECT branch_id, name FROM Branch WHERE branch_id = ? ORDER BY name";
                    params.push(receptionistBranchId);
                } else {
                    query = "SELECT branch_id, name FROM Branch ORDER BY name";
                }
                break;
            case "roles": query = "SELECT role_id, name FROM Role ORDER BY name"; break;
            case "insurance-providers": query = "SELECT id, name FROM Insurance_Provider ORDER BY name"; break;
            case "specialties": query = "SELECT specialty_id, name FROM Specialties ORDER BY name"; break;
            case "treatments": query = "SELECT service_code, name, price FROM Treatment_Catalogue ORDER BY name"; break;
            default: return res.status(404).json({ message: "List type not found" });
        }
        const [results] = await pool.query(query, params);
        res.json(results);
    } catch (err) {
        handleDatabaseError(res, err);
    }
});


// =========================================================================================
// --- ADMIN-SPECIFIC API Endpoints ---
// =========================================================================================

// --- ADMIN DASHBOARD & REPORTS ---
app.get("/api/stats/summary", authorize(['admin']), async (req, res) => {
    try {
        const [[{ patients }]] = await pool.query("SELECT COUNT(*) as patients FROM Patient");
        const [[{ appointments }]] = await pool.query("SELECT COUNT(*) as appointments FROM Appointment WHERE status = 'Scheduled'");
        const [[{ doctors }]] = await pool.query("SELECT COUNT(*) as doctors FROM Doctor");
        res.json({ patients, appointments, doctors });
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/stats/monthly-revenue", authorize(['admin']), async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                DATE_FORMAT(i.issued_date, '%Y-%m') AS month,
                SUM(i.total_amount) AS total_revenue
            FROM Invoice i
            WHERE YEAR(i.issued_date) = YEAR(CURDATE())
            GROUP BY DATE_FORMAT(i.issued_date, '%Y-%m')
            ORDER BY DATE_FORMAT(i.issued_date, '%Y-%m') ASC
        `);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/stats/branch-revenue", authorize(['admin']), async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                b.branch_id,
                b.name AS branch_name,
                SUM(i.total_amount) AS total_revenue,
                ROUND(SUM(i.total_amount) / (SELECT SUM(total_amount) FROM Invoice WHERE YEAR(issued_date) = YEAR(CURDATE())) * 100, 2) AS percentage
            FROM Invoice i
            JOIN Appointment a ON i.appointment_id = a.appointment_id
            JOIN Branch b ON a.branch_id = b.branch_id
            WHERE YEAR(i.issued_date) = YEAR(CURDATE())
            GROUP BY b.branch_id, b.name
            ORDER BY SUM(i.total_amount) DESC
        `);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/reports/:reportName", authorize(['admin']), async (req, res) => {
    const { reportName } = req.params;
    const viewMap = {
        'branch-summary': 'vw_branch_appointment_summary',
        'doctor-revenue': 'vw_doctor_revenue',
        'outstanding-patients': 'vw_patients_outstanding',
        'treatment-stats': 'vw_treatment_statistics',
        'insurance-analysis': 'vw_insurance_analysis'
    };
    const viewName = viewMap[reportName];
    if (!viewName) return res.status(404).json({ message: 'Report not found' });
    try {
        const [rows] = await pool.query(`SELECT * FROM ${viewName}`);
        res.json(rows);
    } catch (err) {
        handleDatabaseError(res, err);
    }
});


// --- ADMIN CRUD OPERATIONS ---
// --- ADMIN CRUD OPERATIONS ---
const createCrudEndpoints = (entityName, tableName, idColumn) => {
    const endpoint = `/api/${entityName}`;

    // GET ALL
    app.get(endpoint, authorize(['admin']), async (req, res) => {
        try {
            const [rows] = await pool.query(`SELECT * FROM ${tableName}`);
            res.json(rows);
        } catch (err) { handleDatabaseError(res, err); }
    });

    // GET BY ID ✅ NEW
    app.get(`${endpoint}/:id`, authorize(['admin']), async (req, res) => {
        try {
            const [rows] = await pool.query(`SELECT * FROM ${tableName} WHERE ${idColumn} = ?`, [req.params.id]);
            if (rows.length === 0) return res.status(404).json({ message: `${entityName} not found` });
            res.json(rows[0]);
        } catch (err) { handleDatabaseError(res, err); }
    });

    // CREATE
    app.post(endpoint, authorize(['admin']), async (req, res) => {
        try {
            const columns = Object.keys(req.body).join(', ');
            const placeholders = Object.keys(req.body).map(() => '?').join(', ');
            const values = Object.values(req.body);
            await pool.query(`INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`, values);
            res.status(201).json({ message: `${entityName} created successfully` });
        } catch (err) { handleDatabaseError(res, err); }
    });

    // UPDATE
    app.put(`${endpoint}/:id`, authorize(['admin']), async (req, res) => {
        try {
            const updates = Object.keys(req.body).map(key => `${key} = ?`).join(', ');
            const values = [...Object.values(req.body), req.params.id];
            await pool.query(`UPDATE ${tableName} SET ${updates} WHERE ${idColumn} = ?`, values);
            res.status(200).json({ message: `${entityName} updated successfully` });
        } catch (err) { handleDatabaseError(res, err); }
    });

    // DELETE
    app.delete(`${endpoint}/:id`, authorize(['admin']), async (req, res) => {
        try {
            await pool.query(`DELETE FROM ${tableName} WHERE ${idColumn} = ?`, [req.params.id]);
            res.status(204).send();
        } catch (err) { handleDatabaseError(res, err); }
    });
};

createCrudEndpoints('insurance-providers', 'Insurance_Provider', 'id');
createCrudEndpoints('treatments', 'Treatment_Catalogue', 'service_code');
createCrudEndpoints('specialties', 'Specialties', 'specialty_id');

// Custom endpoint for fetching managers for the branch edit form
app.get("/api/staff/managers", authorize(['admin']), async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT s.user_id, s.name FROM Staff s
            JOIN Account_Info ai ON s.user_id = ai.user_id
            JOIN Role r ON ai.role_id = r.role_id
            WHERE r.name = 'Branch Manager' ORDER BY s.name ASC
        `);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});


// --- ADMIN BRANCH MANAGEMENT ---
app.get("/api/branches", authorize(['admin']), async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT * FROM Branch ORDER BY name`);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});
app.get("/api/branches/:id", authorize(['admin']), async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT * FROM Branch WHERE branch_id = ?`, [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: `Branch not found` });
        res.json(rows[0]);
    } catch (err) { handleDatabaseError(res, err); }
});

app.post("/api/branches", authorize(['admin']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { name, address, contact_number, manager_name, manager_contact_info, manager_username, manager_email, manager_password } = req.body;

        const [[managerRole]] = await connection.query("SELECT role_id FROM Role WHERE name = 'Branch Manager' LIMIT 1");
        if (!managerRole) throw new Error("The 'Branch Manager' role does not exist.");

        if (!manager_password) throw new Error("Password is required for the new manager.");
        const password_hash = await bcrypt.hash(manager_password, 10);

        const [accountResult] = await connection.query("INSERT INTO Account_Info (role_id, username, password_hash, email) VALUES (?, ?, ?, ?)", [managerRole.role_id, manager_username, password_hash, manager_email]);
        const newUserId = accountResult.insertId;

        await connection.query("INSERT INTO Staff (user_id, name, contact_info, is_medical_staff, branch_id) VALUES (?, ?, ?, ?, NULL)", [newUserId, manager_name, manager_contact_info, false]);

        const [branchResult] = await connection.query("INSERT INTO Branch (name, address, contact_number, manager_user_id) VALUES (?, ?, ?, ?)", [name, address, contact_number, newUserId]);
        const newBranchId = branchResult.insertId;

        await connection.query("UPDATE Staff SET branch_id = ? WHERE user_id = ?", [newBranchId, newUserId]);

        await connection.commit();
        res.status(201).json({ message: "Branch and Manager created successfully." });
    } catch (err) {
        await connection.rollback();
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Manager username or email already exists.' });
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

app.put("/api/branches/:id", authorize(['admin']), async (req, res) => {
    try {
        const updates = Object.keys(req.body).map(key => `${key} = ?`).join(', ');
        const values = [...Object.values(req.body), req.params.id];
        await pool.query(`UPDATE Branch SET ${updates} WHERE branch_id = ?`, values);
        res.status(200).json({ message: `Branch updated successfully` });
    } catch (err) { handleDatabaseError(res, err); }
});

// ADMIN STAFF MANAGEMENT
// ADMIN STAFF MANAGEMENT (SECURE VERSION)
app.get("/api/staff", authorize(['admin']), async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                s.staff_id, s.user_id, s.name, s.contact_info, s.is_medical_staff, s.branch_id, 
                r.name as role_name, 
                COALESCE(b.name, 'Unassigned') as branch_name, 
                ai.username, ai.email,
                GROUP_CONCAT(DISTINCT sp.name SEPARATOR ', ') as doctor_specialties
            FROM Staff s 
            LEFT JOIN Account_Info ai ON s.user_id = ai.user_id 
            LEFT JOIN Role r ON ai.role_id = r.role_id 
            LEFT JOIN Branch b ON s.branch_id = b.branch_id 
            LEFT JOIN Doctor d ON s.staff_id = d.staff_id
            LEFT JOIN doctor_specialties ds ON d.doctor_id = ds.doctor_id
            LEFT JOIN Specialties sp ON ds.specialty_id = sp.specialty_id
            GROUP BY s.staff_id, s.user_id, s.name, s.contact_info, s.is_medical_staff, s.branch_id, r.name, b.name, ai.username, ai.email
            ORDER BY branch_name, role_name, s.name
        `);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});
app.post("/api/staff", authorize(['admin', 'branch manager']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { name, contact_info, branch_id, role_id, username, email, password, is_medical_staff, specialty_ids } = req.body;

        if (req.user.role === 'branch manager') {
            const [[role_to_assign]] = await connection.query("SELECT name FROM Role WHERE role_id = ?", [role_id]);
            if (!role_to_assign || ['Admin', 'Branch Manager'].includes(role_to_assign.name)) throw new Error("Branch managers cannot create Admin or other Manager accounts.");

            const [[manager_branch]] = await connection.query("SELECT branch_id FROM Staff WHERE user_id = ?", [req.user.userId]);
            if (!manager_branch || manager_branch.branch_id.toString() !== branch_id.toString()) throw new Error("You can only add staff to your own branch.");
        }

        if (!password) throw new Error("Password is required for new staff.");
        const password_hash = await bcrypt.hash(password, 10);

        const [accountResult] = await connection.query("INSERT INTO Account_Info (role_id, username, password_hash, email) VALUES (?, ?, ?, ?)", [role_id, username, password_hash, email]);
        const newUserId = accountResult.insertId;

        const [staffResult] = await connection.query("INSERT INTO Staff (user_id, name, contact_info, is_medical_staff, branch_id) VALUES (?, ?, ?, ?, ?)", [newUserId, name, contact_info, is_medical_staff === '1', branch_id]);
        const newStaffId = staffResult.insertId;

        const [[roleCheck]] = await connection.query("SELECT name FROM Role WHERE role_id = ?", [role_id]);
        if (roleCheck.name.toLowerCase() === 'doctor') {
            const specialtiesToAdd = Array.isArray(specialty_ids) ? specialty_ids : (specialty_ids ? [specialty_ids] : []);
            if (specialtiesToAdd.length === 0) throw new Error("At least one specialty is required to create a new doctor.");

            const [doctorResult] = await connection.query("INSERT INTO Doctor (staff_id) VALUES (?)", [newStaffId]);
            const doctorId = doctorResult.insertId;

            const specialtyValues = specialtiesToAdd.map(sid => [doctorId, sid]);
            await connection.query("INSERT INTO doctor_specialties (doctor_id, specialty_id) VALUES ?", [specialtyValues]);
        }

        await connection.commit();
        res.status(201).json({ message: "Staff record created successfully." });
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});
app.get("/api/staff/:id", authorize(['admin']), async (req, res) => {
    try {
        const [staffRows] = await pool.query(`
            SELECT 
                s.staff_id, s.name, s.contact_info, s.branch_id, s.is_medical_staff,
                ai.role_id, ai.username, ai.email
            FROM Staff s 
            LEFT JOIN Account_Info ai ON s.user_id = ai.user_id
            WHERE s.staff_id = ?
        `, [req.params.id]);

        if (staffRows.length === 0) {
            return res.status(404).json({ message: "Staff not found" });
        }

        const staffData = staffRows[0];

        // Check if this staff is a doctor and get specialties
        const [[doctor]] = await pool.query("SELECT doctor_id FROM Doctor WHERE staff_id = ?", [staffData.staff_id]);

        if (doctor) {
            const [specialtyRows] = await pool.query(
                "SELECT specialty_id FROM doctor_specialties WHERE doctor_id = ?",
                [doctor.doctor_id]
            );
            // Attach an array of specialty IDs
            staffData.specialty_ids = specialtyRows.map(r => r.specialty_id);
        } else {
            staffData.specialty_ids = [];
        }

        res.json(staffData);

    } catch (err) {
        handleDatabaseError(res, err);
    }
});

// [AND ADD THIS CODE BLOCK]
// UPDATE Staff (Admin)
app.put("/api/staff/:id", authorize(['admin']), async (req, res) => {
    const connection = await pool.getConnection();
    const staffId = req.params.id;
    const { name, contact_info, branch_id, is_medical_staff, role_id, username, email, specialty_ids, password } = req.body;

    try {
        await connection.beginTransaction();

        // 1. Get the user_id from staff_id
        const [[staff]] = await connection.query("SELECT user_id FROM Staff WHERE staff_id = ?", [staffId]);
        if (!staff) {
            throw new Error("Staff not found.");
        }
        const userId = staff.user_id;

        // 2. Update Staff table
        await connection.query(
            "UPDATE Staff SET name = ?, contact_info = ?, branch_id = ?, is_medical_staff = ? WHERE staff_id = ?",
            [name, contact_info, branch_id, is_medical_staff === '1', staffId]
        );

        // 3. Update Account_Info table (with optional password)
        let accountQuery = "UPDATE Account_Info SET role_id = ?, username = ?, email = ? WHERE user_id = ?";
        let accountParams = [role_id, username, email, userId];

        if (password) { // Check if a new password was provided
            const password_hash = await bcrypt.hash(password, 10);
            accountQuery = "UPDATE Account_Info SET role_id = ?, username = ?, email = ?, password_hash = ? WHERE user_id = ?";
            accountParams = [role_id, username, email, password_hash, userId];
        }
        await connection.query(accountQuery, accountParams);

        // 4. Handle Doctor/Specialty
        const [[roleCheck]] = await connection.query("SELECT name FROM Role WHERE role_id = ?", [role_id]);
        if (roleCheck.name.toLowerCase() === 'doctor') {
            const specialtiesToAdd = Array.isArray(specialty_ids) ? specialty_ids : (specialty_ids ? [specialty_ids] : []);
            if (specialtiesToAdd.length === 0) {
                throw new Error("At least one specialty is required for a doctor.");
            }

            // Check if doctor record exists
            const [[doctor]] = await connection.query("SELECT doctor_id FROM Doctor WHERE staff_id = ?", [staffId]);

            let doctorId;
            if (!doctor) {
                // Create doctor record if it doesn't exist
                const [docResult] = await connection.query("INSERT INTO Doctor (staff_id) VALUES (?)", [staffId]);
                doctorId = docResult.insertId;
            } else {
                doctorId = doctor.doctor_id;
            }

            // Update specialties (delete old, insert new)
            await connection.query("DELETE FROM doctor_specialties WHERE doctor_id = ?", [doctorId]);
            const specialtyValues = specialtiesToAdd.map(sid => [doctorId, sid]);
            await connection.query("INSERT INTO doctor_specialties (doctor_id, specialty_id) VALUES ?", [specialtyValues]);
        }

        await connection.commit();
        res.status(200).json({ message: "Staff member updated successfully." });

    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});
// DELETE Staff (Admin)
app.delete("/api/staff/:id", authorize(['admin']), async (req, res) => {
    const connection = await pool.getConnection();
    const staffId = req.params.id;

    try {
        await connection.beginTransaction();

        // 1. Get user_id from staff_id
        const [[staff]] = await connection.query("SELECT user_id FROM Staff WHERE staff_id = ?", [staffId]);
        if (!staff) {
            throw new Error("Staff not found.");
        }
        const userId = staff.user_id;

        // 2. Check if they are a manager of a branch
        const [[managerCheck]] = await connection.query("SELECT branch_id FROM Branch WHERE manager_user_id = ?", [userId]);
        if (managerCheck) {
            throw new Error(`Cannot delete staff. They are the manager of branch ${managerCheck.branch_id}. Please reassign the branch manager first.`);
        }

        // 3. Check if they are a doctor and delete doctor-related records
        const [[doctor]] = await connection.query("SELECT doctor_id FROM Doctor WHERE staff_id = ?", [staffId]);
        if (doctor) {
            const doctorId = doctor.doctor_id;

            // Delete from doctor_specialties
            await connection.query("DELETE FROM doctor_specialties WHERE doctor_id = ?", [doctorId]);

            // Delete from Doctor. This will fail if the trigger `PreventDoctorDeletionWithAppointments` finds future appointments.
            await connection.query("DELETE FROM Doctor WHERE doctor_id = ?", [doctorId]);
        }

        // 4. Delete from Staff
        await connection.query("DELETE FROM Staff WHERE staff_id = ?", [staffId]);

        // 5. Delete from Account_Info
        await connection.query("DELETE FROM Account_Info WHERE user_id = ?", [userId]);

        await connection.commit();
        res.status(204).send(); // Success, no content

    } catch (err) {
        await connection.rollback();
        // Check for specific errors
        if (err.sqlState === '45000') { // Custom error from trigger
            return res.status(409).json({ message: err.message }); // e.g., "Cannot delete doctor. They have future appointments."
        }
        if (err.errno === 1451) { // Foreign key constraint violation
            return res.status(409).json({ message: "Cannot delete staff. They are referenced by other records (e.g., appointment logs)." });
        }
        // Send the specific error message from our checks (e.g., manager check)
        if (err.message.startsWith("Cannot delete staff")) {
            return res.status(409).json({ message: err.message });
        }
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

// DELETE Branch (Admin)
app.delete("/api/branches/:id", authorize(['admin']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const branchId = req.params.id;

        // Check if branch has any appointments
        const [[appointmentCheck]] = await connection.query(
            "SELECT COUNT(*) as count FROM Appointment WHERE branch_id = ?",
            [branchId]
        );

        if (appointmentCheck.count > 0) {
            await connection.rollback();
            return res.status(409).json({ message: "Cannot delete branch with existing appointments." });
        }

        // Delete branch
        const [result] = await connection.query("DELETE FROM Branch WHERE branch_id = ?", [branchId]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ message: "Branch not found" });
        }

        await connection.commit();
        res.status(204).send();
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

// DELETE Insurance Provider (Admin)
app.delete("/api/insurance-providers/:id", authorize(['admin']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const providerId = req.params.id;

        // Check if provider has any patients
        const [[patientCheck]] = await connection.query(
            "SELECT COUNT(*) as count FROM Patient WHERE insurance_provider_id = ?",
            [providerId]
        );

        if (patientCheck.count > 0) {
            await connection.rollback();
            return res.status(409).json({ message: "Cannot delete insurance provider with enrolled patients." });
        }

        // Delete insurance provider
        const [result] = await connection.query("DELETE FROM Insurance_Provider WHERE id = ?", [providerId]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ message: "Insurance provider not found" });
        }

        await connection.commit();
        res.status(204).send();
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

// DELETE Treatment (Admin)
app.delete("/api/treatments/:code", authorize(['admin']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const serviceCode = req.params.code;

        // Check if treatment has any appointments
        const [[appointmentCheck]] = await connection.query(
            "SELECT COUNT(*) as count FROM Appointment_Treatment WHERE service_code = ?",
            [serviceCode]
        );

        if (appointmentCheck.count > 0) {
            await connection.rollback();
            return res.status(409).json({ message: "Cannot delete treatment that has been used in appointments." });
        }

        // Delete treatment
        const [result] = await connection.query("DELETE FROM Treatment_Catalogue WHERE service_code = ?", [serviceCode]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ message: "Treatment not found" });
        }

        await connection.commit();
        res.status(204).send();
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

// DELETE Specialty (Admin)
app.delete("/api/specialties/:id", authorize(['admin']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const specialtyId = req.params.id;

        // Check if specialty has any doctors
        const [[doctorCheck]] = await connection.query(
            "SELECT COUNT(*) as count FROM doctor_specialties WHERE specialty_id = ?",
            [specialtyId]
        );

        if (doctorCheck.count > 0) {
            await connection.rollback();
            return res.status(409).json({ message: "Cannot delete specialty with doctors assigned." });
        }

        // Delete specialty
        const [result] = await connection.query("DELETE FROM Specialties WHERE specialty_id = ?", [specialtyId]);

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ message: "Specialty not found" });
        }

        await connection.commit();
        res.status(204).send();
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

// =========================================================================================
// --- RECEPTIONIST & BRANCH MANAGER SHARED API Endpoints ---
// =========================================================================================

const commonRoles = ['admin', 'receptionist', 'branch manager'];

app.get("/api/patients", authorize(commonRoles), async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT *, TIMESTAMPDIFF(YEAR, date_of_birth, CURDATE()) AS age FROM Patient ORDER BY name`);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/patients/:id", authorize(commonRoles), async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT * FROM Patient WHERE patient_id = ?`, [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: "Patient not found" });
        res.json(rows[0]);
    } catch (err) { handleDatabaseError(res, err); }
});

app.post("/api/patients", authorize(commonRoles), async (req, res) => {
    try {
        const columns = Object.keys(req.body).join(', ');
        const placeholders = '?,'.repeat(Object.keys(req.body).length).slice(0, -1);
        await pool.query(`INSERT INTO Patient (${columns}) VALUES (${placeholders})`, Object.values(req.body));
        res.status(201).json({ message: `Patient created successfully` });
    } catch (err) { handleDatabaseError(res, err); }
});

app.put("/api/patients/:id", authorize(commonRoles), async (req, res) => {
    try {
        const updates = Object.keys(req.body).map(key => `${key} = ?`).join(', ');
        await pool.query(`UPDATE Patient SET ${updates} WHERE patient_id = ?`, [...Object.values(req.body), req.params.id]);
        res.status(200).json({ message: `Patient updated successfully` });
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/patients/:id/details", authorize(['receptionist']), async (req, res) => {
    const patientId = req.params.id;
    const connection = await pool.getConnection();
    try {
        const [profileRows] = await connection.query(`SELECT p.*, TIMESTAMPDIFF(YEAR, p.date_of_birth, CURDATE()) AS age, ip.name as insurance_provider_name FROM Patient p LEFT JOIN Insurance_Provider ip ON p.insurance_provider_id = ip.id WHERE p.patient_id = ?`, [patientId]);
        if (profileRows.length === 0) return res.status(404).json({ message: "Patient not found." });

        const [historyRows] = await connection.query(`SELECT a.appointment_id, a.schedule_date, a.status, s.name AS doctor_name, i.invoice_id, i.total_amount, i.due_amount, i.status AS invoice_status FROM Appointment a JOIN Doctor d ON a.doctor_id = d.doctor_id JOIN Staff s ON d.staff_id = s.staff_id LEFT JOIN Invoice i ON a.appointment_id = i.appointment_id WHERE a.patient_id = ? ORDER BY a.schedule_date DESC`, [patientId]);

        const [paymentRows] = await connection.query(`SELECT p.* FROM Payment p JOIN Invoice i ON p.invoice_id = i.invoice_id JOIN Appointment a ON i.appointment_id = a.appointment_id WHERE a.patient_id = ? ORDER BY p.payment_date ASC`, [patientId]);

        const history = historyRows.map(appointment => ({ ...appointment, payments: paymentRows.filter(p => p.invoice_id === appointment.invoice_id) }));

        res.json({ profile: profileRows[0], history });
    } catch (err) {
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});


// =========================================================================================
// --- RECEPTIONIST-SPECIFIC API Endpoints ---
// =========================================================================================

app.get("/api/appointments", authorize(['admin', 'receptionist']), async (req, res) => {
    try {
        let query = `SELECT a.*, p.name as patient_name, s.name as doctor_name, b.name as branch_name FROM Appointment a JOIN Patient p ON a.patient_id = p.patient_id JOIN Doctor d ON a.doctor_id = d.doctor_id JOIN Staff s ON d.staff_id = s.staff_id JOIN Branch b ON a.branch_id = b.branch_id`;
        let params = [];

        // If user is receptionist, filter by their branch
        if (req.user.role === 'receptionist') {
            const [[staff]] = await pool.query('SELECT branch_id FROM Staff WHERE user_id = ?', [req.user.userId]);
            if (!staff || !staff.branch_id) {
                return res.status(403).json({ message: 'Receptionist not assigned to any branch.' });
            }
            query += ' WHERE a.branch_id = ?';
            params.push(staff.branch_id);
        }

        query += ' ORDER BY a.schedule_date DESC';
        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/appointments/uninvoiced", authorize(['receptionist']), async (req, res) => {
    try {
        // Get receptionist's branch
        const [[staff]] = await pool.query('SELECT branch_id FROM Staff WHERE user_id = ?', [req.user.userId]);
        if (!staff || !staff.branch_id) {
            return res.status(403).json({ message: 'Receptionist not assigned to any branch.' });
        }

        const [rows] = await pool.query(`SELECT a.appointment_id, a.schedule_date, p.name AS patient_name, p.insurance_provider_id FROM Appointment a JOIN Patient p ON a.patient_id = p.patient_id LEFT JOIN Invoice i ON a.appointment_id = i.appointment_id WHERE a.status = 'Completed' AND i.invoice_id IS NULL AND a.branch_id = ? ORDER BY a.schedule_date DESC`, [staff.branch_id]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/appointments/:id", authorize(['receptionist']), async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT * FROM Appointment WHERE appointment_id = ?`, [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: "Appointment not found" });
        res.json(rows[0]);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/appointments/doctor/:id", authorize(['receptionist']), async (req, res) => {
    try {
        const { id } = req.params;
        const { date } = req.query;
        if (!date) return res.status(400).json({ message: "A date query parameter is required." });

        // Get receptionist's branch
        const [[staff]] = await pool.query('SELECT branch_id FROM Staff WHERE user_id = ?', [req.user.userId]);
        if (!staff || !staff.branch_id) {
            return res.status(403).json({ message: 'Receptionist not assigned to any branch.' });
        }

        const [rows] = await pool.query(`SELECT a.schedule_date, p.name as patient_name FROM Appointment a JOIN Patient p ON a.patient_id = p.patient_id WHERE a.doctor_id = ? AND DATE(a.schedule_date) = ? AND a.branch_id = ?`, [id, date, staff.branch_id]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/doctors/:id/availability", authorize(['receptionist', 'patient']), async (req, res) => {
    try {
        const { id } = req.params;
        const { date } = req.query;
        if (!date) return res.status(400).json({ message: "A date query parameter is required." });

        const appointmentDate = new Date(date);
        const dayOfWeek = appointmentDate.getDay();
        const slotDurationMinutes = 30;

        const [doctorAvailabilitySlots] = await pool.query(
            `SELECT start_time, end_time FROM doctor_availability
             WHERE doctor_id = ? AND day_of_week = ? AND is_available = 1
             ORDER BY start_time`,
            [id, dayOfWeek]
        );

        if (doctorAvailabilitySlots.length === 0) {
            return res.json([]);
        }

        const [bookedAppointments] = await pool.query(
            `SELECT TIME(schedule_date) as booked_time FROM Appointment
             WHERE doctor_id = ? AND DATE(schedule_date) = ? AND status IN ('Scheduled', 'Rescheduled')`,
            [id, date]
        );
        const bookedTimes = bookedAppointments.map((appt) => appt.booked_time);
        const availableSlots = generateAvailableSlots(
            doctorAvailabilitySlots,
            bookedTimes,
            slotDurationMinutes
        );

        res.json(availableSlots);
    } catch (err) { handleDatabaseError(res, err); }
});

app.post("/api/appointments", authorize(['receptionist']), async (req, res) => {
    try {
        const columns = Object.keys(req.body).join(', ');
        const placeholders = '?,'.repeat(Object.keys(req.body).length).slice(0, -1);
        await pool.query(`INSERT INTO Appointment (${columns}) VALUES (${placeholders})`, Object.values(req.body));
        res.status(201).json({ message: `Appointment created successfully` });
    } catch (err) { handleDatabaseError(res, err); }
});

app.put("/api/appointments/:id", authorize(['receptionist']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;
        const { userId } = req.user;

        if (req.body.status === 'Rescheduled' && req.body.schedule_date) {
            const [[staff]] = await connection.query('SELECT staff_id FROM Staff WHERE user_id = ?', [userId]);
            const [[current]] = await connection.query('SELECT schedule_date FROM Appointment WHERE appointment_id = ?', [id]);
            if (!staff || !current) throw new Error("Could not find staff or appointment details.");

            const [log] = await connection.query('INSERT INTO rescheduled_appointments (previous_appointment_id, previous_date, new_date, rescheduled_by_staff_id, reschedule_reason) VALUES (?, ?, ?, ?, ?)', [id, current.schedule_date, req.body.schedule_date, staff.staff_id, req.body.reschedule_reason || null]);

            await connection.query("UPDATE Appointment SET schedule_date = ?, reschedule_id = ?, status = 'Rescheduled' WHERE appointment_id = ?", [req.body.schedule_date, log.insertId, id]);
        } else {
            const updates = Object.keys(req.body).map(key => `${key} = ?`).join(', ');
            await connection.query(`UPDATE Appointment SET ${updates} WHERE appointment_id = ?`, [...Object.values(req.body), id]);
        }
        await connection.commit();
        res.status(200).json({ message: 'Appointment updated successfully' });
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

app.delete("/api/appointments/:id", authorize(['receptionist']), async (req, res) => {
    try {
        await pool.query(`DELETE FROM Appointment WHERE appointment_id = ?`, [req.params.id]);
        res.status(204).send();
    } catch (err) { handleDatabaseError(res, err); }
});


// GET All Invoices (Admin + Receptionist)
app.get("/api/invoices", authorize(['admin', 'receptionist']), async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                i.invoice_id,
                i.appointment_id,
                i.total_amount,
                i.due_amount,
                i.issued_date,
                i.due_date,
                p.name as patient_name,
                CASE
                    WHEN i.due_amount <= 0 THEN 'Paid'
                    WHEN COALESCE((SELECT SUM(paid_amount) FROM Payment WHERE invoice_id = i.invoice_id), 0) > 0 THEN 'Partially Paid'
                    ELSE 'Pending'
                END as status
            FROM Invoice i
            JOIN Appointment a ON i.appointment_id = a.appointment_id
            JOIN Patient p ON a.patient_id = p.patient_id
            ORDER BY i.issued_date DESC
        `);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.post("/api/invoices", authorize(['receptionist']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { appointment_id, insurance_coverage, issued_date, due_date, initial_payment } = req.body;
        if (!appointment_id || !issued_date || !due_date) return res.status(400).json({ message: "Missing required fields." });

        await connection.query("CALL CalculateInvoiceFromTreatments(?, ?, ?, ?, ?, @p_invoice_id)", [appointment_id, insurance_coverage || 0.00, issued_date, due_date, initial_payment || 0.00]);
        const [[{ new_invoice_id }]] = await connection.query("SELECT @p_invoice_id AS new_invoice_id");

        await connection.commit();
        res.status(201).json({ message: "Invoice created successfully.", invoice_id: new_invoice_id });
    } catch (err) {
        await connection.rollback();
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'An invoice already exists for this appointment.' });
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

app.delete("/api/invoices/:id", authorize(['receptionist']), async (req, res) => {
    try {
        await pool.query(`DELETE FROM Invoice WHERE invoice_id = ?`, [req.params.id]);
        res.status(204).send();
    } catch (err) {
        handleDatabaseError(res, err);
    }
});

app.post("/api/payments", authorize(['receptionist']), async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Insert the payment
        await connection.query("INSERT INTO Payment (invoice_id, paid_amount, payment_date, method_of_payment, status) VALUES (?, ?, ?, ?, 'Completed')", [req.body.invoice_id, req.body.paid_amount, req.body.payment_date, req.body.method_of_payment]);

        // Get the invoice total and calculate new due_amount
        const [[invoice]] = await connection.query("SELECT total_amount FROM Invoice WHERE invoice_id = ?", [req.body.invoice_id]);
        const [[payment]] = await connection.query("SELECT COALESCE(SUM(paid_amount), 0) as total_paid FROM Payment WHERE invoice_id = ?", [req.body.invoice_id]);

        const new_due_amount = Math.max(0, invoice.total_amount - payment.total_paid);

        // Update the invoice's due_amount
        await connection.query("UPDATE Invoice SET due_amount = ? WHERE invoice_id = ?", [new_due_amount, req.body.invoice_id]);

        await connection.commit();
        res.status(201).json({ message: "Payment recorded successfully" });
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

// =========================================================================================
// --- DOCTOR-SPECIFIC API Endpoints ---
// =========================================================================================

const getDoctorInfoFromToken = async (req, res, next) => {
    try {
        const [rows] = await pool.query(`SELECT d.doctor_id FROM Doctor d JOIN Staff s ON d.staff_id = s.staff_id WHERE s.user_id = ?`, [req.user.userId]);
        if (rows.length === 0) return res.status(403).json({ message: "Forbidden: The logged-in user is not a doctor." });
        req.doctorId = rows[0].doctor_id;
        next();
    } catch (err) { handleDatabaseError(res, err); }
};

const APPOINTMENT_BASE_QUERY = `
    SELECT a.appointment_id, a.patient_id, a.schedule_date, a.status, 
           p.name as patient_name, p.contact_info as patient_contact, 
           p.gender as patient_gender, p.date_of_birth as patient_age_dob, 
           TIMESTAMPDIFF(YEAR, p.date_of_birth, CURDATE()) as patient_age, 
           ip.name as insurance_provider 
    FROM Appointment a 
    JOIN Patient p ON a.patient_id = p.patient_id 
    LEFT JOIN Insurance_Provider ip ON p.insurance_provider_id = ip.id`;

app.get("/api/doctor/profile", authorize(['doctor']), async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT name FROM Staff WHERE user_id = ?`, [req.user.userId]);
        if (rows.length === 0) return res.status(404).json({ message: "Staff profile not found for this user." });
        res.json(rows[0]);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/doctor/stats", authorize(['doctor']), getDoctorInfoFromToken, async (req, res) => {
    try {
        const [[todayStats]] = await pool.query(`SELECT COUNT(*) as total_appointments, SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN status = 'Scheduled' OR status = 'Rescheduled' THEN 1 ELSE 0 END) as scheduled FROM Appointment WHERE doctor_id = ? AND DATE(schedule_date) = CURDATE()`, [req.doctorId]);
        const [[{ upcoming_week }]] = await pool.query(`SELECT COUNT(*) as upcoming_week FROM Appointment WHERE doctor_id = ? AND schedule_date BETWEEN CURDATE() + INTERVAL 1 DAY AND CURDATE() + INTERVAL 7 DAY`, [req.doctorId]);
        res.json({ today: todayStats, upcoming_week });
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/doctor/appointments/:filter", authorize(['doctor']), getDoctorInfoFromToken, async (req, res) => {
    try {
        const { filter } = req.params;
        let query;
        if (filter === 'today') {
            query = `${APPOINTMENT_BASE_QUERY} WHERE a.doctor_id = ? AND DATE(a.schedule_date) = CURDATE() ORDER BY a.schedule_date ASC`;
        } else if (filter === 'upcoming') {
            query = `${APPOINTMENT_BASE_QUERY} WHERE a.doctor_id = ? AND DATE(a.schedule_date) > CURDATE() ORDER BY a.schedule_date ASC`;
        } else {
            return res.status(400).json({ message: "Invalid filter" });
        }
        const [rows] = await pool.query(query, [req.doctorId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/doctor/appointments/search", authorize(['doctor']), getDoctorInfoFromToken, async (req, res) => {
    try {
        let conditions = " WHERE a.doctor_id = ? ";
        const params = [req.doctorId];
        if (req.query.query) { conditions += " AND p.name LIKE ? "; params.push(`%${req.query.query}%`); }
        if (req.query.startDate && req.query.endDate) { conditions += " AND DATE(a.schedule_date) BETWEEN ? AND ? "; params.push(req.query.startDate, req.query.endDate); }
        const [rows] = await pool.query(`${APPOINTMENT_BASE_QUERY} ${conditions} ORDER BY a.schedule_date ASC`, params);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.post("/api/doctor/appointments/:id/complete", authorize(['doctor']), getDoctorInfoFromToken, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;
        const { consultation_notes, treatments } = req.body;

        // Check if appointment is today
        const [[appointment]] = await connection.query(
            "SELECT schedule_date FROM Appointment WHERE appointment_id = ? AND doctor_id = ?",
            [id, req.doctorId]
        );

        if (!appointment) {
            return res.status(404).json({ message: "Appointment not found." });
        }

        const apptDate = new Date(appointment.schedule_date);
        const today = new Date();

        if (apptDate.toDateString() !== today.toDateString()) {
            return res.status(400).json({ message: "Can only complete today's appointments." });
        }

        // Rest of your existing code...
        await connection.query("UPDATE Appointment SET status = 'Completed', consultation_notes = ? WHERE appointment_id = ? AND doctor_id = ?", [consultation_notes, id, req.doctorId]);

        if (treatments && treatments.length > 0) {
            const treatmentValues = treatments.map(t => [id, t.service_code, t.notes || null, t.actual_price]);
            await connection.query("INSERT INTO Appointment_Treatment (appointment_id, service_code, notes, actual_price) VALUES ?", [treatmentValues]);
        }
        await connection.commit();
        res.status(200).json({ message: "Appointment completed successfully." });
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

app.get("/api/doctor/patients/:patientId/history", authorize(['doctor']), getDoctorInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT a.appointment_id, a.schedule_date, a.status, a.is_emergency, i.total_amount as total_cost, (SELECT GROUP_CONCAT(tc.name SEPARATOR ', ') FROM Appointment_Treatment at JOIN Treatment_Catalogue tc ON at.service_code = tc.service_code WHERE at.appointment_id = a.appointment_id) as treatments FROM Appointment a LEFT JOIN Invoice i ON a.appointment_id = i.appointment_id WHERE a.patient_id = ? AND a.doctor_id = ? ORDER BY a.schedule_date DESC`, [req.params.patientId, req.doctorId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});


// =========================================================================================
// --- BRANCH MANAGER-SPECIFIC API Endpoints ---
// =========================================================================================

const getBranchInfoFromToken = async (req, res, next) => {
    try {
        const [rows] = await pool.query(`SELECT s.branch_id, b.name as branch_name FROM Staff s JOIN Branch b ON s.branch_id = b.branch_id WHERE s.user_id = ?`, [req.user.userId]);
        if (rows.length === 0) return res.status(403).json({ message: "Forbidden: You are not a manager of any branch." });
        req.branchId = rows[0].branch_id;
        req.branchName = rows[0].branch_name;
        next();
    } catch (err) { handleDatabaseError(res, err); }
};

app.get("/api/branch-manager/profile", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [staffRows] = await pool.query(`SELECT name FROM Staff WHERE user_id = ?`, [req.user.userId]);
        if (staffRows.length === 0) return res.status(404).json({ message: "Manager's profile not found." });
        res.json({ staff_name: staffRows[0].name, branch_name: req.branchName, branch_id: req.branchId });
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/stats", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [[{ staff }]] = await pool.query("SELECT COUNT(*) as staff FROM Staff WHERE branch_id = ?", [req.branchId]);
        const [dailyCounts] = await pool.query(`SELECT SUM(CASE WHEN status = 'Scheduled' THEN 1 ELSE 0 END) as scheduled_today, SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed_today, SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) as canceled_today FROM Appointment WHERE branch_id = ? AND DATE(schedule_date) = CURDATE()`, [req.branchId]);
        res.json({ staff, scheduled_today: dailyCounts[0].scheduled_today || 0, completed_today: dailyCounts[0].completed_today || 0, canceled_today: dailyCounts[0].canceled_today || 0 });
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/appointments", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT a.appointment_id, a.schedule_date, a.status, p.name as patient_name, s.name as doctor_name FROM Appointment a JOIN Patient p ON a.patient_id = p.patient_id JOIN Doctor d ON a.doctor_id = d.doctor_id JOIN Staff s ON d.staff_id = s.staff_id WHERE a.branch_id = ? ORDER BY a.schedule_date DESC`, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/staff", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                s.staff_id, s.name, s.contact_info, s.is_medical_staff, r.name as role_name, 
                GROUP_CONCAT(DISTINCT sp.name SEPARATOR ', ') as specialty_name
            FROM Staff s 
            JOIN Account_Info ai ON s.user_id = ai.user_id 
            JOIN Role r ON ai.role_id = r.role_id 
            LEFT JOIN Doctor d ON s.staff_id = d.staff_id 
            LEFT JOIN doctor_specialties ds ON d.doctor_id = ds.doctor_id 
            LEFT JOIN Specialties sp ON ds.specialty_id = sp.specialty_id 
            WHERE s.branch_id = ? AND r.name NOT IN ('Branch Manager','Admin') 
            GROUP BY s.staff_id, s.name, s.contact_info, s.is_medical_staff, r.name 
            ORDER BY s.name ASC
        `, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/staff/:id", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT s.staff_id, s.name, s.contact_info, r.name as role_name, sp.name as specialty_name FROM Staff s JOIN Account_Info ai ON s.user_id = ai.user_id JOIN Role r ON ai.role_id = r.role_id LEFT JOIN Doctor d ON s.staff_id = d.staff_id LEFT JOIN doctor_specialties ds ON d.doctor_id = ds.doctor_id LEFT JOIN Specialties sp ON ds.specialty_id = sp.specialty_id WHERE s.staff_id = ? AND s.branch_id = ?`, [req.params.id, req.branchId]);
        if (rows.length === 0) return res.status(404).json({ message: "Staff member not found in your branch." });
        res.json(rows[0]);
    } catch (err) { handleDatabaseError(res, err); }
});

app.put("/api/branch-manager/staff/:id", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const { name, contact_info } = req.body;
        const [result] = await pool.query("UPDATE Staff SET name = ?, contact_info = ? WHERE staff_id = ? AND branch_id = ?", [name, contact_info, req.params.id, req.branchId]);
        if (result.affectedRows === 0) return res.status(404).json({ message: "Staff not found in your branch." });
        res.status(200).json({ message: "Staff member updated successfully." });
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/invoices", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                i.invoice_id,
                i.total_amount,
                i.due_date,
                i.due_amount,
                p.name as patient_name,
                CASE
                    WHEN i.due_amount <= 0 THEN 'Paid'
                    WHEN COALESCE((SELECT SUM(paid_amount) FROM Payment WHERE invoice_id = i.invoice_id), 0) > 0 THEN 'Partially Paid'
                    ELSE 'Pending'
                END as status
            FROM Invoice i
            JOIN Appointment a ON i.appointment_id = a.appointment_id
            JOIN Patient p ON a.patient_id = p.patient_id
            WHERE a.branch_id = ?
            ORDER BY i.issued_date DESC
        `, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.post("/api/branch-manager/invoices/:invoiceId/payments", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    const { invoiceId } = req.params;
    const { paid_amount, payment_date, method_of_payment } = req.body;
    if (!paid_amount || isNaN(paid_amount) || paid_amount <= 0) return res.status(400).json({ message: "Invalid payment amount." });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [invRows] = await connection.query(`SELECT i.due_amount, i.total_amount FROM Invoice i JOIN Appointment a ON i.appointment_id = a.appointment_id WHERE i.invoice_id = ? AND a.branch_id = ?`, [invoiceId, req.branchId]);
        if (invRows.length === 0 || invRows[0].due_amount <= 0) throw new Error("Invoice not found, not in your branch, or already paid.");

        await connection.query("INSERT INTO Payment (invoice_id, paid_amount, payment_date, method_of_payment, status) VALUES (?, ?, ?, ?, 'Completed')", [invoiceId, paid_amount, payment_date, method_of_payment]);

        // Get the invoice total and calculate new due_amount
        const [[payment]] = await connection.query("SELECT COALESCE(SUM(paid_amount), 0) as total_paid FROM Payment WHERE invoice_id = ?", [invoiceId]);
        const new_due_amount = Math.max(0, invRows[0].total_amount - payment.total_paid);

        // Update the invoice's due_amount
        await connection.query("UPDATE Invoice SET due_amount = ? WHERE invoice_id = ?", [new_due_amount, invoiceId]);

        await connection.commit();
        res.status(201).json({ message: "Payment recorded successfully" });
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

app.delete("/api/branch-manager/appointments/:id", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        // This is a soft delete, changing status to 'Cancelled'

        const { branchId } = req; // Assuming getBranchInfoFromToken middleware is used or will be added
        const [result] = await pool.query(
            `UPDATE Appointment SET status = 'Cancelled' WHERE appointment_id = ? AND branch_id = ?`,
            [req.params.id, branchId]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: "Appointment not found in your branch." });
        res.status(200).json({ message: "Appointment cancelled." });
    } catch (err) {
        handleDatabaseError(res, err);
    }
});

app.get("/api/branch-manager/reports/doctor-revenue", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT s.name as doctor_name, SUM(COALESCE((SELECT SUM(paid_amount) FROM Payment WHERE invoice_id = i.invoice_id), 0)) as total_revenue
            FROM Invoice i
            JOIN Appointment a ON i.appointment_id = a.appointment_id
            JOIN Doctor d ON a.doctor_id = d.doctor_id
            JOIN Staff s ON d.staff_id = s.staff_id
            WHERE a.branch_id = ? AND (i.due_amount <= 0 OR COALESCE((SELECT SUM(paid_amount) FROM Payment WHERE invoice_id = i.invoice_id), 0) > 0)
            GROUP BY s.staff_id, s.name
            ORDER BY total_revenue DESC
        `, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/reports/outstanding-balances", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT p.name as patient_name, i.invoice_id, i.due_amount FROM Invoice i JOIN Appointment a ON i.appointment_id = a.appointment_id JOIN Patient p ON a.patient_id = p.patient_id WHERE a.branch_id = ? AND i.due_amount > 0 ORDER BY p.name`, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/reports/yearly-revenue", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                DATE_FORMAT(i.issued_date, '%Y-%m') AS month,
                SUM(i.total_amount) AS total_revenue,
                SUM(CASE
                    WHEN i.due_amount <= 0 THEN i.total_amount
                    ELSE 0
                END) AS paid_revenue,
                SUM(CASE
                    WHEN i.due_amount > 0 AND COALESCE((SELECT SUM(paid_amount) FROM Payment WHERE invoice_id = i.invoice_id), 0) > 0 THEN i.total_amount
                    ELSE 0
                END) AS partial_revenue,
                SUM(CASE
                    WHEN i.due_amount > 0 AND COALESCE((SELECT SUM(paid_amount) FROM Payment WHERE invoice_id = i.invoice_id), 0) = 0 THEN i.total_amount
                    ELSE 0
                END) AS pending_revenue
            FROM Invoice i
            JOIN Appointment a ON i.appointment_id = a.appointment_id
            WHERE a.branch_id = ? AND YEAR(i.issued_date) = YEAR(CURDATE())
            GROUP BY DATE_FORMAT(i.issued_date, '%Y-%m')
            ORDER BY DATE_FORMAT(i.issued_date, '%Y-%m') ASC
        `, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/reports/patient-arrivals", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                DATE_FORMAT(a.schedule_date, '%Y-%m') AS month,
                COUNT(DISTINCT a.patient_id) AS unique_patients,
                COUNT(*) AS total_appointments,
                SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN a.status = 'Scheduled' THEN 1 ELSE 0 END) AS scheduled,
                SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN a.is_emergency = 1 THEN 1 ELSE 0 END) AS emergency
            FROM Appointment a
            WHERE a.branch_id = ? AND YEAR(a.schedule_date) = YEAR(CURDATE())
            GROUP BY DATE_FORMAT(a.schedule_date, '%Y-%m')
            ORDER BY DATE_FORMAT(a.schedule_date, '%Y-%m') ASC
        `, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/reports/branch-summary", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                DATE(a.schedule_date) AS appointment_date,
                COUNT(*) AS total_appointments,
                SUM(CASE WHEN a.status = 'Scheduled' THEN 1 ELSE 0 END) AS scheduled,
                SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN a.is_emergency = 1 THEN 1 ELSE 0 END) AS emergency
            FROM Appointment a
            WHERE a.branch_id = ? AND YEAR(a.schedule_date) = YEAR(CURDATE())
            GROUP BY DATE(a.schedule_date)
            ORDER BY DATE(a.schedule_date) DESC
        `, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/reports/treatment-stats", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                tc.service_code,
                tc.name AS treatment_name,
                COUNT(at.appointment_id) AS times_performed,
                SUM(at.actual_price) AS total_revenue,
                AVG(at.actual_price) AS avg_price
            FROM Treatment_Catalogue tc
            LEFT JOIN Appointment_Treatment at ON tc.service_code = at.service_code
            LEFT JOIN Appointment a ON at.appointment_id = a.appointment_id
            WHERE a.branch_id = ? AND a.status = 'Completed' AND YEAR(a.schedule_date) = YEAR(CURDATE())
            GROUP BY tc.service_code, tc.name
            ORDER BY total_revenue DESC
        `, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.get("/api/branch-manager/reports/insurance-analysis", authorize(['branch manager']), getBranchInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT
                ip.name AS insurance_provider,
                COUNT(DISTINCT a.patient_id) AS total_patients,
                COUNT(DISTINCT i.invoice_id) AS total_invoices,
                SUM(i.total_amount) AS total_billed,
                SUM(i.insurance_coverage) AS total_insurance_coverage,
                SUM(i.out_of_pocket_amount) AS total_out_of_pocket,
                ROUND(AVG(i.insurance_coverage / i.total_amount * 100), 2) AS avg_coverage_percent
            FROM Insurance_Provider ip
            LEFT JOIN Patient p ON ip.id = p.insurance_provider_id
            LEFT JOIN Appointment a ON p.patient_id = a.patient_id
            LEFT JOIN Invoice i ON a.appointment_id = i.appointment_id
            WHERE a.branch_id = ? AND i.invoice_id IS NOT NULL AND YEAR(a.schedule_date) = YEAR(CURDATE())
            GROUP BY ip.id, ip.name
            ORDER BY total_billed DESC
        `, [req.branchId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

// =========================================================================================
// --- PATIENT-SPECIFIC API Endpoints ---
// =========================================================================================

// --- NEW PATIENT LOGIN ENDPOINT ---
app.post("/api/login/patient", loginRateLimiter, async (req, res) => {
    const { username, password } = req.body; // username = "Anura", password = "03151"
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }

    try {
        // Find all patients whose first name matches the 'username'
        const [rows] = await pool.query(
            "SELECT patient_id, name, date_of_birth FROM Patient WHERE name LIKE ?",
            [username + '%']
        );

        if (rows.length === 0) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        let authenticatedPatient = null;

        // Loop through matches (e.g., "Anura D." and "Anura P.")
        for (const patient of rows) {
            const dob = new Date(patient.date_of_birth);

            // Format month and day to be 2 digits (e.g., '03', '15')
            const month = String(dob.getMonth() + 1).padStart(2, '0');
            const day = String(dob.getDate()).padStart(2, '0');

            // Build the derived password: MM + DD + ID
            const derivedPassword = `${month}${day}${patient.patient_id}`;

            // Check if it matches the password from the app
            if (derivedPassword === password) {
                authenticatedPatient = patient;
                break; // Found our patient
            }
        }

        if (authenticatedPatient) {
            // Success! Create a JWT for this patient
            const token = jwt.sign(
                // Note the different payload: { patientId, role }
                { patientId: authenticatedPatient.patient_id, role: 'patient' },
                JWT_SECRET,
                { expiresIn: '8h' }
            );
            // Return the lowercase role 'patient'
            res.json({ message: "Login successful", token, role: 'patient' });
        } else {
            // Loop finished, no match found
            res.status(401).json({ message: "Invalid credentials." });
        }

    } catch (err) {
        handleDatabaseError(res, err);
    }
});

// --- NEW: GET Available Doctors (for Patients) ---
app.get("/api/patient/doctors", authorize(['patient']), async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                d.doctor_id, 
                s.name, 
                b.branch_id, 
                b.name as branch_name,
                GROUP_CONCAT(DISTINCT sp.name SEPARATOR ', ') as specialty
            FROM Doctor d 
            JOIN Staff s ON d.staff_id = s.staff_id 
            JOIN Branch b ON s.branch_id = b.branch_id
            LEFT JOIN doctor_specialties ds ON d.doctor_id = ds.doctor_id 
            LEFT JOIN Specialties sp ON ds.specialty_id = sp.specialty_id 
            GROUP BY d.doctor_id, s.name, b.branch_id, b.name
            ORDER BY b.name, s.name
        `);
        res.json(rows);
    } catch (err) {
        handleDatabaseError(res, err);
    }
});

// ADD THIS NEW ENDPOINT to server.js
app.get("/api/patient/my-appointments", authorize(['patient']), async (req, res) => {
    try {
        const patientId = req.user.patientId;
        if (!patientId) {
            return res.status(403).json({ message: 'Invalid patient token.' });
        }

        const [rows] = await pool.query(`
            SELECT 
                a.appointment_id,
                a.schedule_date,
                a.status,
                s.name as doctor_name,
                b.name as branch_name
            FROM Appointment a
            JOIN Doctor d ON a.doctor_id = d.doctor_id
            JOIN Staff s ON d.staff_id = s.staff_id
            JOIN Branch b ON a.branch_id = b.branch_id
            WHERE a.patient_id = ?
            ORDER BY a.schedule_date DESC
        `, [patientId]);

        res.json(rows);

    } catch (err) {
        handleDatabaseError(res, err);
    }
});

// --- NEW: GET Patient's Own Documents (for Patients) ---
app.get("/api/patient/my-documents", authorize(['patient']), async (req, res) => {
    try {
        // Get the patientId from the token's payload
        const patientId = req.user.patientId;
        if (!patientId) {
            return res.status(403).json({ message: 'Invalid patient token.' });
        }

        // Query that combines invoices and consultation notes
        const [rows] = await pool.query(`
            (
                SELECT 
                    i.invoice_id as id, 
                    'Invoice' as type, 
                    i.issued_date as date, 
                    CONCAT('Total: $', i.total_amount, ' / Due: $', i.due_amount) as details
                FROM Invoice i
                JOIN Appointment a ON i.appointment_id = a.appointment_id
                WHERE a.patient_id = ?
            )
            UNION
            (
                SELECT 
                    a.appointment_id as id,
                    'Consultation' as type,
                    a.schedule_date as date,
                    a.consultation_notes as details
                FROM Appointment a
                WHERE a.patient_id = ? AND a.status = 'Completed' AND a.consultation_notes IS NOT NULL
            )
            ORDER BY date DESC
        `, [patientId, patientId]);

        res.json(rows);

    } catch (err) {
        handleDatabaseError(res, err);
    }
});

// --- NEW: Book an Appointment (for Patients) ---
app.post("/api/patient/book-appointment", authorize(['patient']), async (req, res) => {
    const { patientId } = req.user;
    const { doctorId, branchId, scheduleDateTime } = req.body; // scheduleDateTime is the START time

    if (!doctorId || !branchId || !scheduleDateTime) {
        return res.status(400).json({ message: "Doctor, branch, and schedule date are required." });
    }

    try {
        // --- START Check 1: Same Doctor, Same Day ---
        const [[{ sameDayDoctorCount }]] = await pool.query(
            `SELECT COUNT(*) as count FROM Appointment
             WHERE patient_id = ?
             AND doctor_id = ?
             AND DATE(schedule_date) = DATE(?)
             AND status IN ('Scheduled', 'Rescheduled')`,
            [patientId, doctorId, scheduleDateTime]
        );

        if (sameDayDoctorCount > 0) {
            return res.status(409).json({ message: "You already have an appointment booked with this doctor today." });
        }
        // --- END CHECK 1 ---

        // --- START Check 2: Overlapping Time Slot (Any Doctor) ---
        // Assume 30-minute slots. Calculate the end time of the requested slot.
        const requestedStartTime = new Date(scheduleDateTime);
        const requestedEndTime = new Date(requestedStartTime.getTime() + 30 * 60000); // Add 30 minutes

        // Query for existing appointments that overlap with the requested time range
        const [overlappingAppointments] = await pool.query(
            `SELECT schedule_date FROM Appointment
             WHERE patient_id = ?
             AND status IN ('Scheduled', 'Rescheduled')
             AND ? < DATE_ADD(schedule_date, INTERVAL 30 MINUTE) -- New start < Existing end
             AND ? > schedule_date`,                         // New end > Existing start
            [patientId, requestedStartTime, requestedEndTime] // Use JS Date objects directly if driver supports it, else format to SQL DATETIME string
        );

        if (overlappingAppointments.length > 0) {
            // Found an overlap
            return res.status(409).json({ message: "This time slot overlaps with another appointment you have booked." });
        }
        // --- END CHECK 2 ---

        // --- START Check 3: Doctor Availability ---
        const appointmentDate = new Date(scheduleDateTime);
        const dayOfWeek = appointmentDate.getDay();
        const appointmentTime = appointmentDate.getHours().toString().padStart(2, '0') + ':' + appointmentDate.getMinutes().toString().padStart(2, '0');

        const [doctorAvailability] = await pool.query(
            `SELECT availability_id FROM doctor_availability
             WHERE doctor_id = ?
             AND day_of_week = ?
             AND is_available = 1
             AND start_time <= ?
             AND end_time > ?`,
            [doctorId, dayOfWeek, appointmentTime, appointmentTime]
        );

        if (doctorAvailability.length === 0) {
            return res.status(409).json({ message: "The doctor is not available at this time. Please select a different time slot." });
        }
        // --- END CHECK 3 ---

        // Proceed with the insert if all checks pass
        await pool.query(
            "INSERT INTO Appointment (patient_id, doctor_id, branch_id, schedule_date, status) VALUES (?, ?, ?, ?, 'Scheduled')",
            [patientId, doctorId, branchId, scheduleDateTime]
        );

        res.status(201).json({ message: "Appointment booked successfully." });

    } catch (err) {
        // Handle doctor's availability trigger
        if (err.sqlState === '45000') {
            return res.status(409).json({ message: "This time slot is no longer available. Please select another time." });
        }
        handleDatabaseError(res, err);
    }
});

// --- DOCTOR AVAILABILITY ENDPOINTS ---
app.get("/api/doctor/availability", authorize(['doctor']), getDoctorInfoFromToken, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT availability_id, day_of_week, start_time, end_time, is_available
            FROM doctor_availability
            WHERE doctor_id = ?
            ORDER BY day_of_week, start_time
        `, [req.doctorId]);
        res.json(rows);
    } catch (err) { handleDatabaseError(res, err); }
});

app.post("/api/doctor/availability", authorize(['doctor']), getDoctorInfoFromToken, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { availabilitySlots } = req.body;

        if (!Array.isArray(availabilitySlots)) {
            await connection.rollback();
            return res.status(400).json({ message: "availabilitySlots must be an array" });
        }

        await connection.query("DELETE FROM doctor_availability WHERE doctor_id = ?", [req.doctorId]);

        for (const slot of availabilitySlots) {
            if (!slot.dayOfWeek && slot.dayOfWeek !== 0) {
                throw new Error("Each slot must have a dayOfWeek");
            }
            if (!slot.startTime || !slot.endTime) {
                throw new Error("Each slot must have startTime and endTime");
            }

            const { dayOfWeek, startTime, endTime, isAvailable } = slot;
            await connection.query(
                "INSERT INTO doctor_availability (doctor_id, day_of_week, start_time, end_time, is_available) VALUES (?, ?, ?, ?, ?)",
                [req.doctorId, dayOfWeek, startTime, endTime, isAvailable ? 1 : 0]
            );
        }

        await connection.commit();
        res.json({ message: "Availability updated successfully" });
    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});

app.delete("/api/doctor/availability/:availabilityId", authorize(['doctor']), getDoctorInfoFromToken, async (req, res) => {
    try {
        const { availabilityId } = req.params;
        const [[slot]] = await pool.query(
            "SELECT doctor_id FROM doctor_availability WHERE availability_id = ?",
            [availabilityId]
        );

        if (!slot || slot.doctor_id !== req.doctorId) {
            return res.status(403).json({ message: "Forbidden: You can only delete your own availability" });
        }

        await pool.query("DELETE FROM doctor_availability WHERE availability_id = ?", [availabilityId]);
        res.status(204).send();
    } catch (err) { handleDatabaseError(res, err); }
});

// =========================================================================================
// --- PROFILE & PASSWORD CHANGE ENDPOINT (All Authenticated Users) ---
// =========================================================================================

app.put("/api/profile/change-password", authorize(['admin', 'receptionist', 'branch manager', 'doctor']), async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current password and new password are required." });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ message: "New password must be at least 6 characters long." });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Get current password hash
        const [[user]] = await connection.query(
            "SELECT password_hash FROM Account_Info WHERE user_id = ?",
            [req.user.userId]
        );

        if (!user) {
            throw new Error("User not found.");
        }

        // Verify current password
        const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isMatch) {
            await connection.rollback();
            return res.status(401).json({ message: "Current password is incorrect." });
        }

        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, 10);

        // Update password
        await connection.query(
            "UPDATE Account_Info SET password_hash = ? WHERE user_id = ?",
            [newPasswordHash, req.user.userId]
        );

        await connection.commit();
        res.json({ message: "Password changed successfully." });

    } catch (err) {
        await connection.rollback();
        handleDatabaseError(res, err);
    } finally {
        connection.release();
    }
});
// Start only when executed directly (allows Jest to import `app` without listening)
if (require.main === module) {
    app.listen(PORT, host, () => {
        console.log(`Server is running on ${host}:${PORT}`);
    });
}

module.exports = { app, pool, loginRateLimiter };
