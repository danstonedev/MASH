const sql = require('mssql');

module.exports = async function (context, req) {
    context.log('DELETE sessions endpoint called');

    const sessionId = req.query.id || (req.body && req.body.id);

    if (!sessionId) {
        context.res = {
            status: 400,
            body: { error: "Please provide a session id" }
        };
        return;
    }

    const connectionString = process.env.SQL_CONNECTION_STRING;

    if (!connectionString) {
        // Mock response for dev
        context.log(`Mock deleting session: ${sessionId}`);
        context.res = {
            status: 200,
            body: { message: "Session deleted (mock)", id: sessionId }
        };
        return;
    }

    try {
        await sql.connect(connectionString);

        const request = new sql.Request();
        request.input('id', sql.VarChar, sessionId);

        const result = await request.query('DELETE FROM Sessions WHERE Id = @id');

        if (result.rowsAffected[0] === 0) {
            context.res = {
                status: 404,
                body: { error: "Session not found" }
            };
            return;
        }

        context.res = {
            status: 200,
            body: { message: "Session deleted", id: sessionId }
        };
    } catch (err) {
        context.log.error(err);
        context.res = {
            status: 500,
            body: { error: "Error deleting from database" }
        };
    }
}
