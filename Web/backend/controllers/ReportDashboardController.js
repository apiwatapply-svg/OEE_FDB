const reportDashboardService = require("../services/reportDashboardService");

module.exports = {
    getDailyDashboard: async (req, res) => {
        try {
            const month = req.query.month;
            if (!month || !/^\d{4}-\d{2}$/.test(month)) {
                return res.status(400).json({ message: "month is required in YYYY-MM format" });
            }
            const results = await reportDashboardService.getDailyDashboard(req.query);
            res.json({ results });
        } catch (err) {
            console.error("Daily dashboard report error:", err);
            res.status(500).json({ message: "Error fetching daily dashboard report", error: err.message });
        }
    },

    getMonthlyDashboard: async (req, res) => {
        try {
            const year = req.query.year;
            if (!year || !/^\d{4}$/.test(year)) {
                return res.status(400).json({ message: "year is required in YYYY format" });
            }
            const results = await reportDashboardService.getMonthlyDashboard(req.query);
            res.json({ results });
        } catch (err) {
            console.error("Monthly dashboard report error:", err);
            res.status(500).json({ message: "Error fetching monthly dashboard report", error: err.message });
        }
    },
};
