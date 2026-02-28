const sql = require('mssql');

function parseJsonSafe(value) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function normalizeSessionRow(row) {
    if (!row || typeof row !== 'object') return row;
    return {
        ...row,
        metrics: parseJsonSafe(row.MetricsJson),
        sensorMapping: parseJsonSafe(row.SensorMappingJson),
        calibrationOffsets: parseJsonSafe(row.CalibrationOffsetsJson),
        tareStates: parseJsonSafe(row.TareStatesJson),
        tags: parseJsonSafe(row.TagsJson),
        environmentalConditions: parseJsonSafe(row.EnvironmentalConditionsJson),
        activityType: row.ActivityType ?? row.activityType,
        notes: row.Notes ?? row.notes,
        sampleRate: row.SampleRate ?? row.sampleRate,
        athleteId: row.AthleteId ?? row.athleteId,
        firmwareVersion: row.FirmwareVersion ?? row.firmwareVersion,
        deviceName: row.DeviceName ?? row.deviceName,
    };
}

module.exports = async function (context, req) {
    context.log('GET sessions endpoint called');

    const sessionId = req.query.id;
    const connectionString = process.env.SQL_CONNECTION_STRING;

    if (!connectionString) {
        // Mock response if no DB connected (for dev skeleton)
        const mockSessions = [
            {
                id: "mock-session-cloud-1",
                name: "Cloud Session Example",
                startTime: Date.now() - 3600000,
                sensorCount: 3,
                duration: 60000
            }
        ];

        if (sessionId) {
            const found = mockSessions.find(s => s.id === sessionId);
            context.res = { body: found || null };
        } else {
            context.res = { body: mockSessions };
        }
        return;
    }

    try {
        await sql.connect(connectionString);

        let result;
        if (sessionId) {
            const request = new sql.Request();
            request.input('id', sql.VarChar, sessionId);
            result = await request.query('SELECT * FROM Sessions WHERE Id = @id');
            context.res = { body: normalizeSessionRow(result.recordset[0]) || null };
        } else {
            result = await sql.query`SELECT * FROM Sessions ORDER BY StartTime DESC`;
            context.res = { body: (result.recordset || []).map(normalizeSessionRow) };
        }
    } catch (err) {
        context.log.error(err);
        context.res = {
            status: 500,
            body: "Error connecting to database"
        };
    }
}
