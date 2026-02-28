const sql = require('mssql');

module.exports = async function (context, req) {
    const session = req.body;

    if (!session || !session.id) {
        context.res = {
            status: 400,
            body: "Please pass a valid session object"
        };
        return;
    }

    const connectionString = process.env.SQL_CONNECTION_STRING;

    if (!connectionString) {
        context.log("Mocking database save for session: " + session.id);
        context.res = {
            status: 201,
            body: { message: "Session saved (mock)", id: session.id }
        };
        return;
    }

    try {
        await sql.connect(connectionString);

        // Build insert dynamically based on available columns.
        // This keeps compatibility with minimal schemas while persisting richer
        // metadata where supported.
        const colReq = new sql.Request();
        const colResult = await colReq.query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = 'Sessions'
        `);
        const sessionColumns = new Set(
            (colResult.recordset || []).map((r) => String(r.COLUMN_NAME || '').toLowerCase())
        );

        const request = new sql.Request();
        const fields = [];
        const values = [];
        const skippedFields = [];

        const addField = (inputKey, columnName, type, value) => {
            if (value === undefined) return;
            if (!sessionColumns.has(columnName.toLowerCase())) {
                skippedFields.push(inputKey);
                return;
            }
            fields.push(columnName);
            values.push(`@${inputKey}`);
            request.input(inputKey, type, value);
        };

        addField('id', 'Id', sql.VarChar, session.id);
        addField('name', 'Name', sql.VarChar, session.name);
        addField('startTime', 'StartTime', sql.BigInt, session.startTime);
        addField('sensorCount', 'SensorCount', sql.Int, session.sensorCount || 0);
        addField('athleteId', 'AthleteId', sql.VarChar, session.athleteId);
        addField('sampleRate', 'SampleRate', sql.Int, session.sampleRate);
        addField('activityType', 'ActivityType', sql.VarChar, session.activityType);
        addField('notes', 'Notes', sql.NVarChar(sql.MAX), session.notes);
        addField('metrics', 'MetricsJson', sql.NVarChar(sql.MAX), session.metrics ? JSON.stringify(session.metrics) : undefined);
        addField('sensorMapping', 'SensorMappingJson', sql.NVarChar(sql.MAX), session.sensorMapping ? JSON.stringify(session.sensorMapping) : undefined);
        addField('calibrationOffsets', 'CalibrationOffsetsJson', sql.NVarChar(sql.MAX), session.calibrationOffsets ? JSON.stringify(session.calibrationOffsets) : undefined);
        addField('tareStates', 'TareStatesJson', sql.NVarChar(sql.MAX), session.tareStates ? JSON.stringify(session.tareStates) : undefined);
        addField('firmwareVersion', 'FirmwareVersion', sql.VarChar, session.firmwareVersion);
        addField('deviceName', 'DeviceName', sql.VarChar, session.deviceName);
        addField('tags', 'TagsJson', sql.NVarChar(sql.MAX), session.tags ? JSON.stringify(session.tags) : undefined);
        addField(
            'environmentalConditions',
            'EnvironmentalConditionsJson',
            sql.NVarChar(sql.MAX),
            session.environmentalConditions
                ? JSON.stringify(session.environmentalConditions)
                : undefined,
        );

        if (fields.length === 0) {
            context.res = {
                status: 400,
                body: { error: "No insertable fields for session" }
            };
            return;
        }

        const query = `INSERT INTO Sessions (${fields.join(', ')}) VALUES (${values.join(', ')})`;
        await request.query(query);

        context.res = {
            status: 201,
            body: { message: "Session saved to Azure SQL", id: session.id, skippedFields }
        };
    } catch (err) {
        context.log.error(err);
        context.res = {
            status: 500,
            body: "Error saving to database"
        };
    }
}
